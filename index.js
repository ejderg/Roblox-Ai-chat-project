require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json({ limit: "256kb" }));

const PORT = process.env.PORT || 3000;
const BACKEND_TOKEN = process.env.BACKEND_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

if (!BACKEND_TOKEN || !GEMINI_API_KEY) {
	throw new Error("BACKEND_TOKEN veya GEMINI_API_KEY eksik.");
}

const MEMORY_FILE = path.join(__dirname, "memory.json");
const MAX_HISTORY_MESSAGES = 20;
const MAX_MESSAGE_LENGTH = 1000;

let memoryStore = loadMemory();

function loadMemory() {
	try {
		if (!fs.existsSync(MEMORY_FILE)) {
			return {};
		}

		const raw = fs.readFileSync(MEMORY_FILE, "utf8");
		if (!raw.trim()) {
			return {};
		}

		return JSON.parse(raw);
	} catch (err) {
		console.error("memory.json okunamadı:", err);
		return {};
	}
}

function saveMemory() {
	try {
		fs.writeFileSync(MEMORY_FILE, JSON.stringify(memoryStore, null, 2), "utf8");
	} catch (err) {
		console.error("memory.json yazılamadı:", err);
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

function getHistory(sessionId) {
	return ensureSession(sessionId).history;
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
	saveMemory();
}

function buildProfileText(profile) {
	const entries = Object.entries(profile || {}).filter(([, v]) => String(v || "").trim() !== "");

	if (entries.length === 0) {
		return "";
	}

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
		},
		{
			key: "language_preference",
			regex: /(?:türkçe konuş|ingilizce konuş|speak english|speak turkish)/i
		}
	];

	for (const item of patterns) {
		const match = text.match(item.regex);
		if (!match) continue;

		if (item.key === "language_preference") {
			if (lower.includes("ingilizce") || lower.includes("english")) {
				session.profile.language_preference = "English";
			} else if (lower.includes("türkçe") || lower.includes("turkish")) {
				session.profile.language_preference = "Türkçe";
			}
		} else {
			session.profile[item.key] = sanitizeText(match[1], 80);
		}
	}

	session.updatedAt = new Date().toISOString();
	saveMemory();
}

async function callGemini(sessionId, userText) {
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
			"x-goog-api-key": GEMINI_API_KEY
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
		persistentMemory: true,
		sessionCount: Object.keys(memoryStore).length
	});
});

app.post("/v1/chat", async (req, res) => {
	try {
		const token = req.headers["x-backend-token"];

		if (token !== BACKEND_TOKEN) {
			return res.status(401).json({ error: "unauthorized" });
		}

		const text = sanitizeText(req.body?.text, 400);
		const sessionId = getSessionId(req.body?.sessionId);

		if (!text) {
			return res.status(400).json({ error: "text gerekli" });
		}

		tryExtractProfile(sessionId, text);

		const reply = await callGemini(sessionId, text);

		pushHistory(sessionId, "user", text);
		pushHistory(sessionId, "model", reply);

		return res.json({
			reply,
			memory: true,
			persistent: true,
			sessionId
		});
	} catch (err) {
		console.log("CRASH:", err);
		return res.status(502).json({
			error: String(err.message || err)
		});
	}
});

app.post("/v1/reset-memory", (req, res) => {
	try {
		const token = req.headers["x-backend-token"];

		if (token !== BACKEND_TOKEN) {
			return res.status(401).json({ error: "unauthorized" });
		}

		const sessionId = getSessionId(req.body?.sessionId);

		delete memoryStore[sessionId];
		saveMemory();

		return res.json({
			ok: true,
			reset: true,
			sessionId
		});
	} catch (err) {
		return res.status(500).json({
			error: String(err.message || err)
		});
	}
});

app.get("/v1/memory/:sessionId", (req, res) => {
	try {
		const token = req.headers["x-backend-token"];

		if (token !== BACKEND_TOKEN) {
			return res.status(401).json({ error: "unauthorized" });
		}

		const sessionId = getSessionId(req.params.sessionId);
		const session = ensureSession(sessionId);

		return res.json({
			ok: true,
			sessionId,
			memory: session
		});
	} catch (err) {
		return res.status(500).json({
			error: String(err.message || err)
		});
	}
});

app.listen(PORT, "0.0.0.0", () => {
	console.log("SERVER ÇALIŞIYOR:", PORT);
});