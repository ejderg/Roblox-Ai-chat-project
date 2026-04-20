require("dotenv").config();

const express = require("express");
const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;
const BACKEND_TOKEN = process.env.BACKEND_TOKEN;

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/v1/chat", (req, res) => {
  try {
    const token = req.headers["x-backend-token"];

    if (token !== BACKEND_TOKEN) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const text = req.body?.text || "boş";

    return res.json({
      reply: ` çalışıyorum kanka: ${text}`
    });
  } catch (err) {
    console.log("CRASH:", err);
    return res.status(500).json({ error: "server crash" });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("SERVER ÇALIŞIYOR:", PORT);
});