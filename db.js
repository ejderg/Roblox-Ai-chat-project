const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
	throw new Error("DATABASE_URL eksik.");
}

const ssl = process.env.DATABASE_SSL_CA
	? { rejectUnauthorized: true, ca: process.env.DATABASE_SSL_CA }
	: { rejectUnauthorized: false };

const pool = new Pool({
	connectionString: process.env.DATABASE_URL,
	ssl,
	max: 10,
	idleTimeoutMillis: 30000,
	connectionTimeoutMillis: 8000,
	query_timeout: 20000,
	statement_timeout: 20000,
	keepAlive: true,
	maxUses: 5000,
});

pool.on("error", (err) => {
	console.error("[pg-pool]", err.message);
});

async function query(text, params = []) {
	return pool.query(text, params);
}

module.exports = {
	pool,
	query,
};