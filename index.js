require("dotenv").config();

const express = require("express");
const { Pool } = require("pg");

const app = express();
app.use(express.json({ limit: "256kb" }));

const PORT = process.env.PORT || 3000;
const BACKEND_TOKEN = process.env.BACKEND_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const DATABASE_URL = process.env.DATABASE_URL;

if (!BACKEND_TOKEN || !GEMINI_API_KEY || !DATABASE_URL) {
	throw new Error("BACKEND_TOKEN, GEMINI_API_KEY veya DATABASE_URL eksik.");
}

const pool = new Pool({
	connectionString: DATABASE_URL,
	ssl: { rejectUnauthorized: false },
});

function nowIso() {
	return new Date().toISOString();
}

function trimText(text, max = 500) {
	return String(text || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function authOk(req) {
	return req.header("x-backend-token") === BACKEND_TOKEN;
}

async function initDb() {
	await pool.query(`
		CREATE TABLE IF NOT EXISTS player_memory (
			player_id TEXT PRIMARY KEY,
			summary TEXT NOT NULL DEFAULT '',
			updated_at TEXT NOT NULL
		);
	`);

	await pool.query(`
		CREATE TABLE IF NOT EXISTS chat_turns (
			id BIGSERIAL PRIMARY KEY,
			player_id TEXT NOT NULL,
			role TEXT NOT NULL,
			content TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
	`);
}

async function getSummary(playerId) {
	const result = await pool.query(
		`SELECT summary FROM player_memory WHERE player_id = $1`,
		[playerId]
	);
	return result.rows[0]?.summary || "";
}

async function getRecentTurns(playerId, limit = 8) {
	const result = await pool.query(
		`SELECT role, content
		 FROM chat_turns
		 WHERE player_id = $1
		 ORDER BY id DESC
		 LIMIT $2`,
		[playerId, limit]
	);
	return result.rows.reverse();
}

async function saveTurn(playerId, role, content) {
	await pool.query(
		`INSERT INTO chat_turns (player_id, role, content, created_at)
		 VALUES ($1, $2, $3, $4)`,
		[playerId, role, trimText(content, 3000), nowIso()]
	);
}

async function saveSummary(playerId, summary) {
	await pool.query(
		`INSERT INTO player_memory (player_id, summary, updated_at)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (player_id)
		 DO UPDATE SET summary = EXCLUDED.summary, updated_at = EXCLUDED.updated_at`,
		[playerId, trimText(summary, 1200), nowIso()]
	);
}

async function callGemini(payload, attempt = 0) {
	const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

	const res = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-goog-api-key": GEMINI_API_KEY,
		},
		body: JSON.stringify(payload),
	});

	if ((res.status === 429 || res.status >= 500) && attempt < 3) {
		const delay = 400 * Math.pow(2, attempt);
		await new Promise((r) => setTimeout(r, delay));
		return callGemini(payload, attempt + 1);
	}

	if (!res.ok) {
		const txt = await res.text().catch(() => "");
		throw new Error(`Gemini hata: ${res.status} ${txt.slice(0, 300)}`);
	}

	const json = await res.json();
	const parts = json?.candidates?.[0]?.content?.parts || [];
	const replyPart = parts.find((p) => typeof p.text === "string");

	if (!replyPart?.text) {
		throw new Error("Gemini boş cevap döndü.");
	}

	return replyPart.text;
}

async function refreshSummary(playerId) {
	const recent = await getRecentTurns(playerId, 10);
	const raw = recent.map((t) => `${t.role}: ${t.content}`).join("\n");
	if (!raw) return;

	const summary = await callGemini({
		systemInstruction: {
			parts: [
				{
					text: "Aşağıdaki sohbetten oyuncuya dair kısa, güvenli ve yararlı bir memory özeti çıkar. Maksimum 4 cümle.",
				},
			],
		},
		contents: [
			{
				role: "user",
				parts: [{ text: raw }],
			},
		],
		generationConfig: {
			temperature: 0.2,
			maxOutputTokens: 120,
		},
	});

	await saveSummary(playerId, summary);
}

app.get("/health", (_req, res) => {
	res.json({ ok: true });
});

app.post("/v1/chat", async (req, res) => {
	if (!authOk(req)) {
		return res.status(401).json({ error: "Unauthorized" });
	}

	const playerId = trimText(req.body?.playerId, 64);
	const userText = trimText(req.body?.text, 400);

	if (!playerId || !userText) {
		return res.status(400).json({ error: "Bad input" });
	}

	try {
		const summary = await getSummary(playerId);
		const recent = await getRecentTurns(playerId, 8);

		const history = recent.map((t) => ({
			role: t.role === "assistant" ? "model" : "user",
			parts: [{ text: t.content }],
		}));

		const reply = await callGemini({
			systemInstruction: {
				parts: [
					{
						text: "Sen Roblox içinde çalışan yardımsever bir asistansın. Kullanıcı hangi dilde yazarsa o dilde cevap ver. Kısa, net ve doğal konuş.",
					},
				],
			},
			contents: [
				...(summary
					? [
							{
								role: "user",
								parts: [{ text: `Oyuncu hakkında memory özeti:\n${summary}` }],
							},
					  ]
					: []),
				...history,
				{
					role: "user",
					parts: [{ text: userText }],
				},
			],
			generationConfig: {
				temperature: 0.7,
				maxOutputTokens: 220,
			},
		});

		await saveTurn(playerId, "user", userText);
		await saveTurn(playerId, "assistant", reply);

		refreshSummary(playerId).catch(() => {});

		return res.json({ reply });
	} catch (err) {
		return res.status(502).json({
			error: String(err.message || err),
		});
	}
});

app.listen(PORT, "0.0.0.0", async () => {
	try {
		await initDb();
		console.log(`AI backend çalışıyor: http://127.0.0.1:${PORT}`);
	} catch (err) {
		console.error("DB init error:", err);
		process.exit(1);
	}
});