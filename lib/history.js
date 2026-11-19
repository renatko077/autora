const fs = require('node:fs');
const crypto = require('node:crypto');
const MAGIC = Buffer.from('AUTORA_HISTORY_V1\n');

function parseKey(value) {
  if (!/^[a-f0-9]{64}$/i.test(value || '')) throw new Error('HISTORY_IMPORT_KEY must contain 64 hexadecimal characters.');
  return Buffer.from(value, 'hex');
}

function encryptHistory(value, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', parseKey(key), iv);
  cipher.setAAD(MAGIC);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), encrypted]);
}

function decryptHistory(file, key) {
  const encoded = fs.readFileSync(file);
  if (!encoded.subarray(0, MAGIC.length).equals(MAGIC) || encoded.length < MAGIC.length + 29) throw new Error('Invalid encrypted history bundle.');
  const iv = encoded.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = encoded.subarray(MAGIC.length + 12, MAGIC.length + 28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', parseKey(key), iv);
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(tag);
  const decoded = Buffer.concat([decipher.update(encoded.subarray(MAGIC.length + 28)), decipher.final()]);
  return JSON.parse(decoded.toString('utf8'));
}

module.exports = { encryptHistory, decryptHistory };
