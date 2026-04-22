require("dotenv").config();

const express = require("express");
const app = express();

app.use(express.json({ limit: "256kb" }));

const PORT = process.env.PORT || 3000;
const BACKEND_TOKEN = process.env.BACKEND_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

if (!BACKEND_TOKEN || !GEMINI_API_KEY) {
	throw new Error("BACKEND_TOKEN veya GEMINI_API_KEY eksik.");
}

const cache = new Map();

function getCacheKey(text) {
	return String(text || "").trim().toLowerCase();
}

async function callGemini(userText) {
	const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

	const payload = {
		systemInstruction: {
			parts: [
				{
					text: "Sen Roblox içinde çalışan yardımsever bir AI asistansın. Kullanıcı hangi dilde yazarsa o dilde cevap ver. Kısa, doğal ve anlaşılır konuş."
				}
			]
		},
		contents: [
			{
				role: "user",
				parts: [{ text: userText }]
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
	res.json({ ok: true });
});

app.get("/routes-test", (_req, res) => {
	res.json({
		ok: true,
		chatPostShouldExist: true
	});
});

app.post("/v1/chat", async (req, res) => {
	try {
		const token = req.headers["x-backend-token"];

		if (token !== BACKEND_TOKEN) {
			return res.status(401).json({ error: "unauthorized" });
		}

		const text = String(req.body?.text || "").trim();

		if (!text) {
			return res.status(400).json({ error: "text gerekli" });
		}

		const safeText = text.slice(0, 400);
		const cacheKey = getCacheKey(safeText);

		if (cache.has(cacheKey)) {
			return res.json({
				reply: cache.get(cacheKey),
				cached: true
			});
		}

		const reply = await callGemini(safeText);

		cache.set(cacheKey, reply);

		if (cache.size > 100) {
			const firstKey = cache.keys().next().value;
			cache.delete(firstKey);
		}

		return res.json({
			reply,
			cached: false
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