require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json({ limit: "512kb" }));

const PORT = process.env.PORT || 3000;
const BACKEND_TOKEN = process.env.BACKEND_TOKEN;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

if (!BACKEND_TOKEN) {
	throw new Error("BACKEND_TOKEN eksik.");
}

const MEMORY_FILE = path.join(__dirname, "memory.json");
const KEYS_FILE = path.join(__dirname, "user_keys.json");

const MAX_HISTORY_MESSAGES = 20;
const MAX_MESSAGE_LENGTH = 1000;

let memoryStore = loadJson(MEMORY_FILE, {});
let keyStore = loadJson(KEYS_FILE, {});

function loadJson(filePath, fallback) {
	try {
		if (!fs.existsSync(filePath)) return fallback;
		const raw = fs.readFileSync(filePath, "utf8");
		if (!raw.trim()) return fallback;
		return JSON.parse(raw);
	} catch (err) {
		console.error("JSON okunamadı:", filePath, err);
		return fallback;
	}
}

function saveJson(filePath, data) {
	try {
		fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
	} catch (err) {
		console.error("JSON yazılamadı:", filePath, err);
	}
}

function getSessionId(raw) {
	const value = String(raw || "").trim();
	return value || "global";
}

function sanitizeText(text, maxLen = MAX_MESSAGE_LENGTH) {
	return String(text || "").trim().slice(0, maxLen);
}

function ensureSession(sessionId) {
	if (!memoryStore[sessionId]) {
		memoryStore[sessionId] = {
			history: [],
			profile: {},
			updatedAt: new Date().toISOString()
		};
	}
	return memoryStore[sessionId];
}

function pushHistory(sessionId, role, text) {
	const session = ensureSession(sessionId);

	session.history.push({
		role,
		parts: [{ text: sanitizeText(text) }]
	});

	if (session.history.length > MAX_HISTORY_MESSAGES) {
		session.history.splice(0, session.history.length - MAX_HISTORY_MESSAGES);
	}

	session.updatedAt = new Date().toISOString();
	saveJson(MEMORY_FILE, memoryStore);
}

function buildProfileText(profile) {
	const entries = Object.entries(profile || {}).filter(([, v]) => String(v || "").trim() !== "");
	if (entries.length === 0) return "";
	const lines = entries.map(([key, value]) => `- ${key}: ${value}`);
	return `Kullanıcı hakkında bilinen kalıcı bilgiler:\n${lines.join("\n")}`;
}

function tryExtractProfile(sessionId, userText) {
	const text = sanitizeText(userText, 300);
	const lower = text.toLowerCase();
	const session = ensureSession(sessionId);

	const patterns = [
		{
			key: "name",
			regex: /(?:benim adım|adım|my name is|i am)\s+([a-zA-ZçÇğĞıİöÖşŞüÜ0-9_ -]{2,40})/i
		},
		{
			key: "favorite_color",
			regex: /(?:en sevdiğim renk|favorite color is)\s+([a-zA-ZçÇğĞıİöÖşŞüÜ -]{2,30})/i
		}
	];

	for (const item of patterns) {
		const match = text.match(item.regex);
		if (match) {
			session.profile[item.key] = sanitizeText(match[1], 80);
		}
	}

	if (lower.includes("türkçe konuş") || lower.includes("speak turkish")) {
		session.profile.language_preference = "Türkçe";
	}

	if (lower.includes("ingilizce konuş") || lower.includes("speak english")) {
		session.profile.language_preference = "English";
	}

	session.updatedAt = new Date().toISOString();
	saveJson(MEMORY_FILE, memoryStore);
}

function getUserKey(sessionId) {
	const row = keyStore[sessionId];
	if (!row) return "";
	return String(row.apiKey || "").trim();
}

async function validateGeminiKey(apiKey) {
	const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;

	const res = await fetch(url, {
		method: "GET"
	});

	if (!res.ok) {
		const txt = await res.text().catch(() => "");
		return {
			ok: false,
			error: `Geçersiz key: ${res.status} ${txt.slice(0, 200)}`
		};
	}

	return { ok: true };
}

async function callGemini(apiKey, sessionId, userText) {
	const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

	const session = ensureSession(sessionId);
	const profileText = buildProfileText(session.profile);

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
			...session.history,
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

app.get("/health", (_req, res) => {
	res.json({
		ok: true,
		byok: true,
		sessionCount: Object.keys(memoryStore).length,
		keyCount: Object.keys(keyStore).length
	});
});

app.post("/v1/set-key", async (req, res) => {
	try {
		const token = req.headers["x-backend-token"];
		if (token !== BACKEND_TOKEN) {
			return res.status(401).json({ error: "unauthorized" });
		}

		const sessionId = getSessionId(req.body?.sessionId);
		const apiKey = String(req.body?.apiKey || "").trim();
		const playerName = String(req.body?.playerName || "").trim();

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

		keyStore[sessionId] = {
			apiKey,
			playerName,
			updatedAt: new Date().toISOString()
		};
		saveJson(KEYS_FILE, keyStore);

		return res.json({
			ok: true,
			sessionId,
			message: "API key başarıyla bağlandı."
		});
	} catch (err) {
		return res.status(500).json({
			error: String(err.message || err)
		});
	}
});

app.post("/v1/remove-key", (req, res) => {
	try {
		const token = req.headers["x-backend-token"];
		if (token !== BACKEND_TOKEN) {
			return res.status(401).json({ error: "unauthorized" });
		}

		const sessionId = getSessionId(req.body?.sessionId);
		delete keyStore[sessionId];
		saveJson(KEYS_FILE, keyStore);

		return res.json({
			ok: true,
			sessionId,
			message: "API key kaldırıldı."
		});
	} catch (err) {
		return res.status(500).json({
			error: String(err.message || err)
		});
	}
});

app.get("/v1/key-status/:sessionId", (req, res) => {
	try {
		const token = req.headers["x-backend-token"];
		if (token !== BACKEND_TOKEN) {
			return res.status(401).json({ error: "unauthorized" });
		}

		const sessionId = getSessionId(req.params.sessionId);
		const hasKey = !!getUserKey(sessionId);

		return res.json({
			ok: true,
			sessionId,
			hasKey
		});
	} catch (err) {
		return res.status(500).json({
			error: String(err.message || err)
		});
	}
});

app.post("/v1/chat", async (req, res) => {
	try {
		const token = req.headers["x-backend-token"];
		if (token !== BACKEND_TOKEN) {
			return res.status(401).json({ error: "unauthorized" });
		}

		const sessionId = getSessionId(req.body?.sessionId);
		const text = sanitizeText(req.body?.text, 400);

		if (!text) {
			return res.status(400).json({ error: "text gerekli" });
		}

		const apiKey = getUserKey(sessionId);
		if (!apiKey) {
			return res.status(400).json({
				error: "Önce kendi Gemini API key'ini bağlaman lazım."
			});
		}

		tryExtractProfile(sessionId, text);

		const reply = await callGemini(apiKey, sessionId, text);

		pushHistory(sessionId, "user", text);
		pushHistory(sessionId, "model", reply);

		return res.json({
			reply,
			sessionId,
			memory: true,
			byok: true
		});
	} catch (err) {
		console.log("CRASH:", err);
		return res.status(502).json({
			error: String(err.message || err)
		});
	}
});

app.listen(PORT, "0.0.0.0", () => {
	console.log("SERVER ÇALIŞIYOR:", PORT);
});