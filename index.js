require("dotenv").config();

const express = require("express");
const { query } = require("./db");
const { initSchema } = require("./schema");
const { encryptText, decryptText } = require("./crypto-utils");

const app = express();
app.use(express.json({ limit: "512kb" }));

const PORT = process.env.PORT || 3000;
const BACKEND_TOKEN = process.env.BACKEND_TOKEN;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

if (!BACKEND_TOKEN) {
	throw new Error("BACKEND_TOKEN eksik.");
}

function getSessionId(raw) {
	const value = String(raw || "").trim();
	return value || "global";
}

function sanitizeText(text, maxLen = 1000) {
	return String(text || "").trim().slice(0, maxLen);
}

async function getStoredApiKey(sessionId) {
	const result = await query(
		`SELECT encrypted_key FROM user_keys WHERE session_id = $1`,
		[sessionId]
	);

	if (result.rows.length === 0) {
		return "";
	}

	return decryptText(result.rows[0].encrypted_key);
}

async function validateGeminiKey(apiKey) {
	const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
	const res = await fetch(url);

	if (!res.ok) {
		const txt = await res.text().catch(() => "");
		return {
			ok: false,
			error: `Geçersiz key: ${res.status} ${txt.slice(0, 200)}`,
		};
	}

	return { ok: true };
}

async function getProfile(sessionId) {
	const result = await query(
		`SELECT profile_json FROM user_profiles WHERE session_id = $1`,
		[sessionId]
	);

	if (result.rows.length === 0) {
		return {};
	}

	return result.rows[0].profile_json || {};
}

async function saveProfile(sessionId, profile) {
	await query(
		`
		INSERT INTO user_profiles (session_id, profile_json, updated_at)
		VALUES ($1, $2::jsonb, NOW())
		ON CONFLICT (session_id)
		DO UPDATE SET
			profile_json = EXCLUDED.profile_json,
			updated_at = NOW()
		`,
		[sessionId, JSON.stringify(profile || {})]
	);
}

function buildProfileText(profile) {
	const entries = Object.entries(profile || {}).filter(([, v]) => String(v || "").trim() !== "");
	if (entries.length === 0) return "";

	return "Kullanıcı hakkında bilinen bilgiler:\n" +
		entries.map(([k, v]) => `- ${k}: ${v}`).join("\n");
}

async function tryExtractProfile(sessionId, userText) {
	const text = sanitizeText(userText, 300);
	const lower = text.toLowerCase();
	const profile = await getProfile(sessionId);

	const nameMatch = text.match(/(?:benim adım|adım|my name is|i am)\s+([a-zA-ZçÇğĞıİöÖşŞüÜ0-9_ -]{2,40})/i);
	if (nameMatch) {
		profile.name = sanitizeText(nameMatch[1], 80);
	}

	const favColorMatch = text.match(/(?:en sevdiğim renk|favorite color is)\s+([a-zA-ZçÇğĞıİöÖşŞüÜ -]{2,30})/i);
	if (favColorMatch) {
		profile.favorite_color = sanitizeText(favColorMatch[1], 40);
	}

	if (lower.includes("türkçe konuş") || lower.includes("speak turkish")) {
		profile.language_preference = "Türkçe";
	}

	if (lower.includes("ingilizce konuş") || lower.includes("speak english")) {
		profile.language_preference = "English";
	}

	await saveProfile(sessionId, profile);
	return profile;
}

async function getSessionMessages(sessionId, limit = 20) {
	const result = await query(
		`
		SELECT role, text, created_at
		FROM conversation_messages
		WHERE session_id = $1
		ORDER BY created_at DESC, id DESC
		LIMIT $2
		`,
		[sessionId, limit]
	);

	return result.rows.reverse().map((row) => ({
		role: row.role,
		parts: [{ text: row.text }],
	}));
}

async function addMessage(sessionId, role, text) {
	await query(
		`
		INSERT INTO conversation_messages (session_id, role, text)
		VALUES ($1, $2, $3)
		`,
		[sessionId, role, sanitizeText(text, 1000)]
	);
}

async function resetSessionMessages(sessionId) {
	await query(
		`DELETE FROM conversation_messages WHERE session_id = $1`,
		[sessionId]
	);
}

async function logUsage({ sessionId, playerName, eventType, inputText = "", outputText = "" }) {
	await query(
		`
		INSERT INTO usage_events
		(session_id, player_name, event_type, input_text, output_text, input_chars, output_chars)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		`,
		[
			sessionId,
			playerName || "",
			eventType,
			sanitizeText(inputText, 1000),
			sanitizeText(outputText, 1000),
			String(inputText || "").length,
			String(outputText || "").length,
		]
	);
}

async function getUserUsage(sessionId) {
	const totalResult = await query(
		`
		SELECT
			COUNT(*)::int AS total_requests,
			COALESCE(SUM(input_chars), 0)::int AS total_input_chars,
			COALESCE(SUM(output_chars), 0)::int AS total_output_chars
		FROM usage_events
		WHERE session_id = $1 AND event_type = 'chat'
		`,
		[sessionId]
	);

	const dayResult = await query(
		`
		SELECT COUNT(*)::int AS last_24h_requests
		FROM usage_events
		WHERE session_id = $1
		  AND event_type = 'chat'
		  AND created_at >= NOW() - INTERVAL '24 hours'
		`,
		[sessionId]
	);

	return {
		totalRequests: totalResult.rows[0]?.total_requests || 0,
		totalInputChars: totalResult.rows[0]?.total_input_chars || 0,
		totalOutputChars: totalResult.rows[0]?.total_output_chars || 0,
		last24hRequests: dayResult.rows[0]?.last_24h_requests || 0,
	};
}

async function getTopUsers(limit = 20) {
	const result = await query(
		`
		SELECT
			session_id,
			MAX(player_name) AS player_name,
			COUNT(*)::int AS total_requests,
			COALESCE(SUM(input_chars), 0)::int AS total_input_chars,
			COALESCE(SUM(output_chars), 0)::int AS total_output_chars
		FROM usage_events
		WHERE event_type = 'chat'
		GROUP BY session_id
		ORDER BY total_requests DESC
		LIMIT $1
		`,
		[limit]
	);

	return result.rows;
}

async function callGemini(apiKey, sessionId, userText) {
	const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

	const history = await getSessionMessages(sessionId, 20);
	const profile = await getProfile(sessionId);
	const profileText = buildProfileText(profile);

	const systemText = [
		"Sen Roblox içinde çalışan yardımsever bir AI asistansın.",
		"Kullanıcı hangi dilde yazarsa o dilde cevap ver.",
		"Kısa, doğal ve anlaşılır konuş.",
		"Sohbet geçmişini dikkate al.",
		"Kullanıcıyla ilgili kayıtlı bilgileri uygun olduğunda kullan."
	].join(" ");

	const payload = {
		systemInstruction: {
			parts: [
				{
					text: profileText ? `${systemText}\n\n${profileText}` : systemText
				}
			]
		},
		contents: [
			...history,
			{
				role: "user",
				parts: [{ text: sanitizeText(userText, 400) }]
			}
		],
		generationConfig: {
			temperature: 0.7,
			maxOutputTokens: 180
		}
	};

	const res = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-goog-api-key": apiKey
		},
		body: JSON.stringify(payload)
	});

	if (!res.ok) {
		const txt = await res.text().catch(() => "");
		throw new Error(`Gemini hata: ${res.status} ${txt.slice(0, 300)}`);
	}

	const json = await res.json();
	const parts = json?.candidates?.[0]?.content?.parts || [];
	const replyPart = parts.find((p) => typeof p.text === "string" && p.text.trim() !== "");

	if (!replyPart) {
		throw new Error("Gemini boş cevap döndü.");
	}

	return replyPart.text.trim();
}

app.get("/health", async (_req, res) => {
	try {
		const userCount = await query(`SELECT COUNT(*)::int AS count FROM user_keys`);
		const messageCount = await query(`SELECT COUNT(*)::int AS count FROM conversation_messages`);

		res.json({
			ok: true,
			encryptedKeys: true,
			databaseMemory: true,
			usageTracking: true,
			usersWithKeys: userCount.rows[0]?.count || 0,
			totalMessages: messageCount.rows[0]?.count || 0,
		});
	} catch (err) {
		res.status(500).json({
			ok: false,
			error: String(err.message || err),
		});
	}
});

app.post("/v1/set-key", async (req, res) => {
	try {
		const token = req.headers["x-backend-token"];
		if (token !== BACKEND_TOKEN) {
			return res.status(401).json({ error: "unauthorized" });
		}

		const sessionId = getSessionId(req.body?.sessionId);
		const playerName = sanitizeText(req.body?.playerName, 80);
		const apiKey = String(req.body?.apiKey || "").trim();

		if (!apiKey) {
			return res.status(400).json({ error: "apiKey gerekli" });
		}

		if (!apiKey.startsWith("AIza")) {
			return res.status(400).json({ error: "Bu Gemini key gibi görünmüyor." });
		}

		const valid = await validateGeminiKey(apiKey);
		if (!valid.ok) {
			return res.status(400).json({ error: valid.error });
		}

		const encryptedKey = encryptText(apiKey);

		await query(
			`
			INSERT INTO user_keys (session_id, player_name, encrypted_key, created_at, updated_at)
			VALUES ($1, $2, $3, NOW(), NOW())
			ON CONFLICT (session_id)
			DO UPDATE SET
				player_name = EXCLUDED.player_name,
				encrypted_key = EXCLUDED.encrypted_key,
				updated_at = NOW()
			`,
			[sessionId, playerName, encryptedKey]
		);

		await logUsage({
			sessionId,
			playerName,
			eventType: "set_key",
		});

		return res.json({
			ok: true,
			sessionId,
			message: "API key başarıyla bağlandı.",
		});
	} catch (err) {
		return res.status(500).json({
			error: String(err.message || err),
		});
	}
});

app.post("/v1/remove-key", async (req, res) => {
	try {
		const token = req.headers["x-backend-token"];
		if (token !== BACKEND_TOKEN) {
			return res.status(401).json({ error: "unauthorized" });
		}

		const sessionId = getSessionId(req.body?.sessionId);

		await query(`DELETE FROM user_keys WHERE session_id = $1`, [sessionId]);

		return res.json({
			ok: true,
			sessionId,
			message: "API key kaldırıldı.",
		});
	} catch (err) {
		return res.status(500).json({ error: String(err.message || err) });
	}
});

app.get("/v1/key-status/:sessionId", async (req, res) => {
	try {
		const token = req.headers["x-backend-token"];
		if (token !== BACKEND_TOKEN) {
			return res.status(401).json({ error: "unauthorized" });
		}

		const sessionId = getSessionId(req.params.sessionId);
		const result = await query(`SELECT 1 FROM user_keys WHERE session_id = $1`, [sessionId]);

		return res.json({
			ok: true,
			sessionId,
			hasKey: result.rows.length > 0,
		});
	} catch (err) {
		return res.status(500).json({ error: String(err.message || err) });
	}
});

app.post("/v1/chat", async (req, res) => {
	try {
		const token = req.headers["x-backend-token"];
		if (token !== BACKEND_TOKEN) {
			return res.status(401).json({ error: "unauthorized" });
		}

		const sessionId = getSessionId(req.body?.sessionId);
		const playerName = sanitizeText(req.body?.playerName, 80);
		const text = sanitizeText(req.body?.text, 400);

		if (!text) {
			return res.status(400).json({ error: "text gerekli" });
		}

		const apiKey = await getStoredApiKey(sessionId);
		if (!apiKey) {
			return res.status(400).json({
				error: "Önce kendi Gemini API key'ini bağlaman lazım."
			});
		}

		await tryExtractProfile(sessionId, text);

		const reply = await callGemini(apiKey, sessionId, text);

		await addMessage(sessionId, "user", text);
		await addMessage(sessionId, "model", reply);

		await logUsage({
			sessionId,
			playerName,
			eventType: "chat",
			inputText: text,
			outputText: reply,
		});

		return res.json({
			reply,
			sessionId,
			memory: true,
			database: true,
		});
	} catch (err) {
		return res.status(502).json({
			error: String(err.message || err),
		});
	}
});

app.post("/v1/reset-memory", async (req, res) => {
	try {
		const token = req.headers["x-backend-token"];
		if (token !== BACKEND_TOKEN) {
			return res.status(401).json({ error: "unauthorized" });
		}

		const sessionId = getSessionId(req.body?.sessionId);
		await resetSessionMessages(sessionId);

		return res.json({
			ok: true,
			sessionId,
			reset: true,
		});
	} catch (err) {
		return res.status(500).json({ error: String(err.message || err) });
	}
});

app.get("/v1/usage/:sessionId", async (req, res) => {
	try {
		const token = req.headers["x-backend-token"];
		if (token !== BACKEND_TOKEN) {
			return res.status(401).json({ error: "unauthorized" });
		}

		const sessionId = getSessionId(req.params.sessionId);
		const usage = await getUserUsage(sessionId);

		return res.json({
			ok: true,
			sessionId,
			usage,
		});
	} catch (err) {
		return res.status(500).json({ error: String(err.message || err) });
	}
});

app.get("/v1/admin/usage-top", async (req, res) => {
	try {
		const token = req.headers["x-backend-token"];
		if (token !== BACKEND_TOKEN) {
			return res.status(401).json({ error: "unauthorized" });
		}

		const users = await getTopUsers(20);

		return res.json({
			ok: true,
			users,
		});
	} catch (err) {
		return res.status(500).json({ error: String(err.message || err) });
	}
});

(async () => {
	try {
		await initSchema();
		app.listen(PORT, "0.0.0.0", () => {
			console.log("SERVER ÇALIŞIYOR:", PORT);
		});
	} catch (err) {
		console.error("Startup hatası:", err);
		process.exit(1);
	}
})();