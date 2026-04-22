const crypto = require("crypto");

const ALGO = "aes-256-gcm";
const IV_LENGTH = 12;
const KEY_LENGTH = 32;

function getKey() {
	const secret = process.env.ENCRYPTION_SECRET;
	if (!secret) {
		throw new Error("ENCRYPTION_SECRET eksik.");
	}
	return crypto.scryptSync(secret, "aichatbot-salt-v1", KEY_LENGTH);
}

function encryptText(plainText) {
	const iv = crypto.randomBytes(IV_LENGTH);
	const key = getKey();

	const cipher = crypto.createCipheriv(ALGO, key, iv);
	const encrypted = Buffer.concat([
		cipher.update(String(plainText), "utf8"),
		cipher.final(),
	]);

	const tag = cipher.getAuthTag();

	return JSON.stringify({
		iv: iv.toString("base64"),
		tag: tag.toString("base64"),
		data: encrypted.toString("base64"),
	});
}

function decryptText(payload) {
	const parsed = JSON.parse(payload);
	const key = getKey();

	const iv = Buffer.from(parsed.iv, "base64");
	const tag = Buffer.from(parsed.tag, "base64");
	const data = Buffer.from(parsed.data, "base64");

	const decipher = crypto.createDecipheriv(ALGO, key, iv);
	decipher.setAuthTag(tag);

	const decrypted = Buffer.concat([
		decipher.update(data),
		decipher.final(),
	]);

	return decrypted.toString("utf8");
}

module.exports = {
	encryptText,
	decryptText,
};