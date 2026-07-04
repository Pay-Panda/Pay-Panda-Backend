const crypto = require('crypto');
const { encryptionKey } = require('../config');

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map(part => part.toString('base64url')).join('.');
}

function decrypt(payload) {
  const [iv, tag, encrypted] = payload.split('.').map(part => Buffer.from(part, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

function randomId(prefix, bytes = 18) {
  return `${prefix}_${crypto.randomBytes(bytes).toString('base64url')}`;
}

module.exports = { encrypt, decrypt, randomId };
