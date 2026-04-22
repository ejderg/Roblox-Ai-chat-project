const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
	throw new Error("DATABASE_URL eksik.");
}

const pool = new Pool({
	connectionString: process.env.DATABASE_URL,
	ssl: { rejectUnauthorized: false },
	max: 10,
	idleTimeoutMillis: 30000,
	connectionTimeoutMillis: 10000,
});

async function query(text, params = []) {
	return pool.query(text, params);
}

async function getClient() {
	return pool.connect();
}

module.exports = {
	pool,
	query,
	getClient,
};