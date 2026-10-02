const crypto = require("crypto");

const ALGO = "aes-256-gcm";
const IV_LENGTH = 12;
const KEY_LENGTH = 32;
const V2_SALT_LENGTH = 16;
const LEGACY_SALT = "aichatbot-salt-v1";

let cachedSecret = null;
let cachedKey = null;

function getKey(salt) {
	const secret = process.env.ENCRYPTION_SECRET;
	if (!secret) {
		throw new Error("ENCRYPTION_SECRET eksik.");
	}

	if (cachedSecret === secret && cachedKey && cachedKey.salt === salt) {
		return cachedKey.key;
	}

	const key = crypto.scryptSync(secret, salt, KEY_LENGTH, {
		N: 32768,
		r: 8,
		p: 1,
		maxmem: 64 * 1024 * 1024
	});

	cachedSecret = secret;
	cachedKey = { salt, key };
	return key;
}

function encryptText(plainText) {
	const salt = crypto.randomBytes(V2_SALT_LENGTH);
	const iv = crypto.randomBytes(IV_LENGTH);
	const key = getKey(salt);
	const cipher = crypto.createCipheriv(ALGO, key, iv);
	const encrypted = Buffer.concat([
		cipher.update(String(plainText), "utf8"),
		cipher.final(),
	]);
	const tag = cipher.getAuthTag();

	return JSON.stringify({
		v: 2,
		salt: salt.toString("base64"),
		iv: iv.toString("base64"),
		tag: tag.toString("base64"),
		data: encrypted.toString("base64"),
	});
}

function decryptText(payload) {
	const parsed = JSON.parse(payload);
	const version = Number(parsed?.v || 1);
	const salt = version === 2
		? Buffer.from(parsed.salt || "", "base64")
		: LEGACY_SALT;

	if (version === 2 && salt.length !== V2_SALT_LENGTH) {
		throw new Error("Geçersiz encrypted payload.");
	}

	const key = getKey(salt);
	const iv = Buffer.from(parsed.iv || "", "base64");
	const tag = Buffer.from(parsed.tag || "", "base64");
	const data = Buffer.from(parsed.data || "", "base64");

	if (iv.length !== IV_LENGTH || tag.length !== 16 || data.length === 0) {
		throw new Error("Geçersiz encrypted payload.");
	}

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
