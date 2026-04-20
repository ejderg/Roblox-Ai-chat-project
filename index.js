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

app.get("/health", (_req, res) => {
	res.json({ ok: true });
});

app.listen(PORT, "0.0.0.0", () => {
	console.log(`AI backend çalışıyor: http://127.0.0.1:${PORT}`);
});