const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const root = path.resolve(__dirname, '..');
if (fs.existsSync(path.join(root, '.env.local'))) process.loadEnvFile(path.join(root, '.env.local'));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autora-test-'));
const password = crypto.randomBytes(24).toString('hex');
let child, base, port, entryCookie, sessionCookie, createdOrder;

async function start() {
  child = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root, env: { ...process.env, PORT: String(port), ADMIN_PASSWORD: password,
      ADMIN_SESSION_SECRET: password, ORDERS_FILE: path.join(directory, 'orders.json') }, stdio: ['ignore','pipe','pipe']
  });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Server timeout: ${errors}`)), 10000);
    child.once('error', reject);
    child.stdout.on('data', chunk => { if (String(chunk).includes('AUTORA is listening')) { clearTimeout(timeout); resolve(); } });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited ${code}: ${errors}`)); });
  });
  base = `http://127.0.0.1:${port}`;
}
async function stop() {
  if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
}
function request(route, options = {}) { return fetch(base + route, options); }
function json(method, body, cookie) { return { method, headers: { 'Content-Type':'application/json', ...(cookie ? {Cookie:cookie} : {}) }, body:JSON.stringify(body) }; }
function cookieOf(response) { return response.headers.getSetCookie()[0].split(';')[0]; }
before(async () => {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  await start();
});
after(async () => {
  await stop();
  const resolved = path.resolve(directory);
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('autora-test-'));
  fs.rmSync(resolved, {recursive:true,force:true});
});

test('health, imported catalog, assets and direct product URLs', async () => {
  assert.equal((await request('/health')).status, 200);
  const products = await (await request('/api/products')).json();
  assert.equal(products.length, 235);
  assert.equal(new Set(products.map(p => p.id)).size, 235);
  assert.equal(products[0].name, 'Автомобільний тримач телефону на дефлектор');
  for (const product of products) {
    assert.ok(product.price_from > 0 && product.price_to >= product.price_from);
    assert.ok(fs.existsSync(path.join(root,'public',product.image_url)));
  }
  assert.equal((await request('/assets/hero.webp')).headers.get('content-type'), 'image/webp');
  const direct = await request('/tovar/avtomobilnyi-trymach-telefonu-na-deflektor-1');
  assert.equal(direct.status, 200);
  assert.match(await direct.text(), /AUTORA/);
  assert.equal((await request('/unknown-file.json')).status, 404);
});

test('private documents and admin are closed before authentication', async () => {
  for (const route of ['/admin','/admin.html','/staff-console','/data/private/statement-import.json','/data/private/statement.pdf','/server.js','/.env.local']) {
    assert.equal((await request(route)).status,404,route);
  }
  for (const route of ['/api/admin/orders','/api/admin/statement.pdf','/api/admin/statement-original.pdf']) assert.equal((await request(route)).status,401);
  assert.equal((await request('/api/admin/login',json('POST',{password}))).status,404);
});

test('order prices are calculated on server and bad carts are rejected', async () => {
  const input = { name:'Тестовий покупець',phone:'+380671112233',delivery:'Київ, відділення 1',items:[{productId:1,quantity:2,unitPrice:1}],amount:1 };
  const response = await request('/api/orders',json('POST',input));
  assert.equal(response.status,201);
  createdOrder = await response.json();
  assert.match(createdOrder.reference,/^AU-\d{4}-[A-F0-9]{6}$/);
  assert.equal(createdOrder.amount,610);
  assert.equal(createdOrder.status,'awaiting_payment');
  for (const items of [[],[{productId:999,quantity:1}],[{productId:1,quantity:51}],[{productId:1,quantity:1.5}],[{productId:1,quantity:1},{productId:1,quantity:1}]]) {
    assert.equal((await request('/api/orders',json('POST',{...input,items}))).status,400);
  }
  const crossOrigin = json('POST',input);crossOrigin.headers.Origin='https://example.invalid';
  assert.equal((await request('/api/orders',crossOrigin)).status,403);
  assert.equal((await request('/api/orders',{method:'POST',headers:{'Content-Type':'application/json'},body:'{broken'})).status,400);
});

test('entry token cannot be substituted for a password-authenticated session', async () => {
  const entry = await request('/api/admin/entry',{method:'POST'});
  assert.equal(entry.status,200);entryCookie=cookieOf(entry);
  assert.match(entry.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
  const forged=entryCookie.replace('autora_admin_entry=','autora_admin_session=');
  assert.equal((await request('/api/admin/orders',{headers:{Cookie:forged}})).status,401);
  assert.equal((await request('/staff-console',{headers:{Cookie:entryCookie}})).status,200);
  assert.equal((await request('/api/admin/login',json('POST',{password:'incorrect'},entryCookie))).status,401);
  const login=await request('/api/admin/login',json('POST',{password},entryCookie));
  assert.equal(login.status,200);sessionCookie=cookieOf(login);
});

test('authenticated history reconciles and original statement remains unchanged', { skip: !process.env.HISTORY_IMPORT_KEY && 'Set HISTORY_IMPORT_KEY to verify the private import.' }, async () => {
  const expected = require('../lib/history').decryptHistory(path.join(root,'data/statement.enc'), process.env.HISTORY_IMPORT_KEY).statement;
  const response=await request('/api/admin/orders',{headers:{Cookie:sessionCookie}});
  assert.equal(response.status,200);
  const {orders,statement}=await response.json();
  assert.equal(orders.length,1);assert.equal(orders[0].reference,createdOrder.reference);
  assert.equal(statement.transactionCount,339);assert.equal(statement.transactions.length,339);
  assert.equal(statement.summary.creditTurnover,expected.summary.creditTurnover);
  assert.equal(statement.summary.debitTurnover,expected.summary.debitTurnover);
  assert.deepEqual(statement.validation,{creditsReconciled:true,debitsReconciled:true,everyBalanceReconciled:true});
  let balance=0;
  for (const tx of [...statement.transactions].reverse()) {
    balance+=Math.round(tx.accountAmount*100);assert.equal(balance,Math.round(tx.balanceAfter*100),tx.id);
  }
  assert.equal(balance,Math.round(expected.summary.closingBalance*100));
  const pdf=await request('/api/admin/statement.pdf',{headers:{Cookie:sessionCookie}});
  assert.equal(pdf.headers.get('content-type'),'application/pdf');
  assert.ok(Buffer.from(await pdf.arrayBuffer()).subarray(0,5).equals(Buffer.from('%PDF-')));
  const original=await request('/api/admin/statement-original.pdf',{headers:{Cookie:sessionCookie}});
  assert.equal(crypto.createHash('sha256').update(Buffer.from(await original.arrayBuffer())).digest('hex'), '1430bf3bdb2c8135029622170c75bf30680b5db65dbb18c80be1bdc10ae287c3');
});

test('status changes persist across restart and session-only console reload works', async () => {
  assert.equal((await request('/staff-console',{headers:{Cookie:sessionCookie}})).status,200);
  const route=`/api/admin/orders/${createdOrder.reference}`;
  assert.equal((await request(route,json('PATCH',{status:'unknown'},sessionCookie))).status,400);
  assert.equal((await request(route,json('PATCH',{status:'paid'},sessionCookie))).status,200);
  await stop();await start();
  const data=await (await request('/api/admin/orders',{headers:{Cookie:sessionCookie}})).json();
  assert.equal(data.orders[0].status,'paid');assert.equal(data.orders[0].amount,610);
  const logout=await request('/api/admin/logout',{method:'POST',headers:{Cookie:sessionCookie}});
  assert.match(logout.headers.get('set-cookie'),/Max-Age=0/);
  assert.equal((await request('/api/admin/orders')).status,401);
});
