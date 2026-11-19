const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { encryptHistory, decryptHistory } = require('../lib/history');
const root = path.join(__dirname, '..');
const envFile = path.join(root, '.env.local');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
let key = process.env.HISTORY_IMPORT_KEY;
if (!key) {
  key = crypto.randomBytes(32).toString('hex');
  fs.appendFileSync(envFile, `\n# Add this value to Railway Variables. Keep it out of Git.\nHISTORY_IMPORT_KEY=${key}\n`, {mode:0o600});
}
const privateDir = path.join(root, 'data', 'private');
const bundle = {
  statement: JSON.parse(fs.readFileSync(path.join(privateDir, 'statement-import.json'), 'utf8')),
  pdf: fs.readFileSync(path.join(privateDir, 'statement.pdf')).toString('base64'),
  originalPdf: fs.readFileSync(path.join(privateDir, 'statement-original.pdf')).toString('base64')
};
const file = path.join(root, 'data', 'statement.enc');
fs.writeFileSync(file, encryptHistory(bundle, key));
const verified = decryptHistory(file, key);
if (JSON.stringify(verified) !== JSON.stringify(bundle)) throw new Error('Encrypted history verification failed.');
console.log(`Encrypted and verified ${verified.statement.transactionCount} transactions and both PDF files. Key remains in ignored .env.local.`);
