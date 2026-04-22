const { query } = require("./db");

async function initSchema() {
	await query(`
		CREATE TABLE IF NOT EXISTS user_keys (
			session_id TEXT PRIMARY KEY,
			player_name TEXT,
			encrypted_key TEXT NOT NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		);
	`);

	await query(`
		CREATE TABLE IF NOT EXISTS conversation_messages (
			id BIGSERIAL PRIMARY KEY,
			session_id TEXT NOT NULL,
			role TEXT NOT NULL,
			text TEXT NOT NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		);
	`);

	await query(`
		CREATE INDEX IF NOT EXISTS idx_conversation_session_created
		ON conversation_messages(session_id, created_at DESC);
	`);

	await query(`
		CREATE TABLE IF NOT EXISTS usage_events (
			id BIGSERIAL PRIMARY KEY,
			session_id TEXT NOT NULL,
			player_name TEXT,
			event_type TEXT NOT NULL,
			input_text TEXT,
			output_text TEXT,
			input_chars INTEGER NOT NULL DEFAULT 0,
			output_chars INTEGER NOT NULL DEFAULT 0,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		);
	`);

	await query(`
		CREATE INDEX IF NOT EXISTS idx_usage_session_created
		ON usage_events(session_id, created_at DESC);
	`);

	await query(`
		CREATE TABLE IF NOT EXISTS user_profiles (
			session_id TEXT PRIMARY KEY,
			profile_json JSONB NOT NULL DEFAULT '{}'::jsonb,
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		);
	`);
}

module.exports = {
	initSchema,
};