const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
	throw new Error("DATABASE_URL eksik.");
}

const ssl = {
	rejectUnauthorized: true,
	...(process.env.DATABASE_SSL_CA ? { ca: process.env.DATABASE_SSL_CA } : {})
};

// Prevent pg-connection-string from replacing these verified TLS options with
// weaker sslmode/ssl values from DATABASE_URL.
const databaseUrl = new URL(process.env.DATABASE_URL);
databaseUrl.searchParams.delete("sslmode");
databaseUrl.searchParams.delete("ssl");

const pool = new Pool({
	connectionString: databaseUrl.toString(),
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
