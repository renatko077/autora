const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { encryptHistory, decryptHistory } = require('../lib/history');

test('history encryption round-trips, rejects incorrect keys and detects tampering', () => {
  const file = path.join(os.tmpdir(), `autora-history-test-${crypto.randomBytes(8).toString('hex')}.enc`);
  const key = crypto.randomBytes(32).toString('hex');
  const fixture = {statement:{transactions:[{id:'TEST-1',amount:123,details:'Synthetic private test entry'}]},pdf:'JVBERi0=',originalPdf:'JVBERi0='};
  try {
    const encoded = encryptHistory(fixture, key);
    assert.equal(encoded.includes(Buffer.from('Synthetic private test entry')), false);
    fs.writeFileSync(file, encoded);
    assert.deepEqual(decryptHistory(file,key),fixture);
    assert.throws(()=>decryptHistory(file,crypto.randomBytes(32).toString('hex')));
    encoded[encoded.length-1]^=1;
    fs.writeFileSync(file,encoded);
    assert.throws(()=>decryptHistory(file,key));
  } finally {fs.rmSync(file,{force:true});}
});
