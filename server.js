const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { decryptHistory } = require('./lib/history');

const LOCAL_ENV = path.join(__dirname, '.env.local');
if (fs.existsSync(LOCAL_ENV) && typeof process.loadEnvFile === 'function') process.loadEnvFile(LOCAL_ENV);

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const PRODUCTS_FILE = path.join(__dirname, 'data', 'products.json');
const PRODUCT_IMAGES_FILE = path.join(__dirname, 'data', 'product-images.json');
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data', 'runtime');
const ORDERS_FILE = path.resolve(process.env.ORDERS_FILE || path.join(DATA_DIR, 'orders.json'));
const STATEMENT_FILE = path.resolve(process.env.STATEMENT_FILE || path.join(__dirname, 'data', 'private', 'statement-import.json'));
const STATEMENT_PDF_FILE = path.join(__dirname, 'data', 'private', 'statement.pdf');
const STATEMENT_ORIGINAL_FILE = path.join(__dirname, 'data', 'private', 'statement-original.pdf');
const HISTORY_BUNDLE_FILE = path.join(__dirname, 'data', 'statement.enc');
let historyCache;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || ADMIN_PASSWORD;
const SESSION_COOKIE = 'autora_admin_session';
const ADMIN_ENTRY_COOKIE = 'autora_admin_entry';
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const ADMIN_ENTRY_TTL_SECONDS = 2 * 60;
const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
};
const ORDER_STATUSES = new Set(['awaiting_payment', 'paid', 'processing', 'shipped', 'cancelled']);

const products = JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8'));
const productImages = new Map(JSON.parse(fs.readFileSync(PRODUCT_IMAGES_FILE, 'utf8')).map((image) => [image.id, image]));
const catalog = products.map((product) => ({ ...product, ...(productImages.get(product.id) || {}) }));
const productsById = new Map(products.map((product) => [product.id, product]));

function send(res, status, body, contentType = 'text/plain; charset=utf-8', extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(body);
}

function sendJson(res, status, value, headers = {}) {
  send(res, status, JSON.stringify(value), 'application/json; charset=utf-8', headers);
}

function serveFile(res, absolutePath) {
  fs.readFile(absolutePath, (error, contents) => {
    if (error) {
      send(res, 404, 'Not found');
      return;
    }
    const contentType = CONTENT_TYPES[path.extname(absolutePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Frame-Options': 'DENY',
      'Cache-Control': /\.(?:html|css|js|json)$/i.test(absolutePath) ? 'no-cache' : 'public, max-age=3600'
    });
    res.end(contents);
  });
}

function readJsonBody(req, maximumBytes = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    let tooLarge = false;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      if (tooLarge) return;
      size += Buffer.byteLength(chunk);
      if (size > maximumBytes) {
        tooLarge = true;
        body = '';
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(Object.assign(new Error('Request body is too large'), { statusCode: 413 }));
        return;
      }
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function readOrders() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('Orders storage must contain an array.');
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function readHistoryBundle() {
  if (!fs.existsSync(HISTORY_BUNDLE_FILE)) return null;
  if (historyCache) return historyCache;
  if (!process.env.HISTORY_IMPORT_KEY) throw Object.assign(new Error('Додайте HISTORY_IMPORT_KEY у Variables Railway, щоб відкрити історію.'), { statusCode: 503 });
  try {
    historyCache = decryptHistory(HISTORY_BUNDLE_FILE, process.env.HISTORY_IMPORT_KEY);
    return historyCache;
  } catch {
    throw Object.assign(new Error('Не вдалося розшифрувати історію. Перевірте HISTORY_IMPORT_KEY.'), { statusCode: 503 });
  }
}

function readStatementImport() {
  try {
    const encrypted = readHistoryBundle();
    if (encrypted) return encrypted.statement;
    return JSON.parse(fs.readFileSync(STATEMENT_FILE, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT' && error.statusCode !== 503) throw error;
    return {
      sourceFileName: null,
      summary: {
        bank: '',
        statementTitle: error.statusCode === 503 ? error.message : 'Виписка не імпортована',
        accountHolder: '',
        accountIban: '',
        periodStart: '',
        periodEnd: '',
        openingBalance: 0,
        closingBalance: 0,
        creditTurnover: 0,
        debitTurnover: 0,
        sourcePageCount: 0
      },
      transactionCount: 0,
      transactions: []
    };
  }
}

function writeOrders(orders) {
  fs.mkdirSync(path.dirname(ORDERS_FILE), { recursive: true });
  const temporaryFile = `${ORDERS_FILE}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(orders, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporaryFile, ORDERS_FILE);
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => {
    const separator = part.indexOf('=');
    if (separator < 0) return ['', ''];
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try { return [key, decodeURIComponent(value)]; } catch { return [key, '']; }
  }).filter(([key]) => key));
}

function sessionToken(cookieName, ttlSeconds = SESSION_TTL_SECONDS) {
  if (!SESSION_SECRET) return '';
  const payload = `${Date.now() + ttlSeconds * 1000}.${crypto.randomBytes(18).toString('base64url')}`;
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(`${cookieName}:${payload}`).digest('base64url');
  return `${payload}.${signature}`;
}

function hasSignedCookie(req, cookieName) {
  if (!SESSION_SECRET) return false;
  const token = parseCookies(req.headers.cookie)[cookieName] || '';
  const separator = token.lastIndexOf('.');
  if (separator < 0) return false;
  const payload = token.slice(0, separator);
  const suppliedSignature = token.slice(separator + 1);
  const expiresAt = Number(payload.slice(0, payload.indexOf('.')));
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
  const expectedSignature = crypto.createHmac('sha256', SESSION_SECRET).update(`${cookieName}:${payload}`).digest('base64url');
  const expected = Buffer.from(expectedSignature);
  const supplied = Buffer.from(suppliedSignature);
  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
}

function hasAdminSession(req) {
  return hasSignedCookie(req, SESSION_COOKIE);
}

function hasAdminEntry(req) {
  return hasSignedCookie(req, ADMIN_ENTRY_COOKIE);
}

function isSameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function secureCookie(req) {
  return req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
}

function requireAdmin(req, res) {
  if (hasAdminSession(req)) return true;
  sendJson(res, 401, { error: 'Потрібен вхід адміністратора.' });
  return false;
}

function createOrder(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error('Перевірте дані замовлення.'), { statusCode: 400 });
  }
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 100) : '';
  const phone = typeof input.phone === 'string' ? input.phone.trim().slice(0, 30) : '';
  const delivery = typeof input.delivery === 'string' ? input.delivery.trim().slice(0, 180) : '';
  if (name.length < 2 || !/^[+0-9()\-\s]{9,30}$/.test(phone) || phone.replace(/\D/g, '').length < 9 || delivery.length < 3) {
    throw Object.assign(new Error('Перевірте ім’я, телефон і адресу доставки.'), { statusCode: 400 });
  }
  if (!Array.isArray(input.items) || input.items.length === 0 || input.items.length > 25) {
    throw Object.assign(new Error('Кошик порожній або має надто багато позицій.'), { statusCode: 400 });
  }

  const seen = new Set();
  const items = input.items.map((entry) => {
    const id = Number(entry?.productId);
    const quantity = Number(entry?.quantity);
    const product = productsById.get(id);
    if (!product || !Number.isInteger(quantity) || quantity < 1 || quantity > 50 || seen.has(id)) {
      throw Object.assign(new Error('Не вдалося перевірити склад кошика.'), { statusCode: 400 });
    }
    seen.add(id);
    const price = Math.round((product.price_from + product.price_to) / 2);
    return { productId: id, name: product.name, unitPrice: price, quantity };
  });
  const amount = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  const now = new Date();
  let reference;
  const orders = readOrders();
  do {
    reference = `AU-${now.getFullYear()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  } while (orders.some((order) => order.reference === reference));

  const order = {
    reference,
    createdAt: now.toISOString(),
    name,
    phone,
    delivery,
    items,
    amount,
    currency: 'UAH',
    status: 'awaiting_payment'
  };
  orders.unshift(order);
  writeOrders(orders);
  return order;
}

const server = http.createServer(async (req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    send(res, 400, 'Bad request');
    return;
  }

  if (req.method === 'GET' && pathname === '/health') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/products') {
    sendJson(res, 200, catalog);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/orders') {
    if (!isSameOrigin(req)) return sendJson(res, 403, { error: 'Запит відхилено.' });
    try {
      const input = await readJsonBody(req);
      const order = createOrder(input);
      sendJson(res, 201, order);
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.statusCode ? error.message : 'Не вдалося зберегти замовлення.' });
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/admin/session') {
    if (!hasAdminEntry(req) && !hasAdminSession(req)) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    if (!ADMIN_PASSWORD) {
      sendJson(res, 503, { error: 'Адміністратор ще не налаштований. Додайте змінну ADMIN_PASSWORD.' });
      return;
    }
    sendJson(res, 200, { authenticated: hasAdminSession(req) });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/admin/entry') {
    if (!isSameOrigin(req)) {
      sendJson(res, 403, { error: 'Запит відхилено.' });
      return;
    }
    if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 8 || !SESSION_SECRET) {
      sendJson(res, 503, { error: 'Задайте ADMIN_PASSWORD довжиною щонайменше 8 символів у змінних середовища.' });
      return;
    }
    const cookie = `${ADMIN_ENTRY_COOKIE}=${encodeURIComponent(sessionToken(ADMIN_ENTRY_COOKIE, ADMIN_ENTRY_TTL_SECONDS))}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ADMIN_ENTRY_TTL_SECONDS}${secureCookie(req)}`;
    sendJson(res, 200, { ready: true }, { 'Set-Cookie': cookie });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/admin/login') {
    if (!hasAdminEntry(req)) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 8 || !SESSION_SECRET) {
      sendJson(res, 503, { error: 'Налаштуйте ADMIN_PASSWORD довжиною щонайменше 8 символів.' });
      return;
    }
    if (!isSameOrigin(req)) {
      sendJson(res, 403, { error: 'Запит відхилено.' });
      return;
    }
    try {
      const input = await readJsonBody(req, 2 * 1024);
      const supplied = Buffer.from(typeof input.password === 'string' ? input.password : '');
      const expected = Buffer.from(ADMIN_PASSWORD);
      const matches = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
      if (!matches) {
        sendJson(res, 401, { error: 'Неправильний пароль.' });
        return;
      }
      const cookie = `${SESSION_COOKIE}=${encodeURIComponent(sessionToken(SESSION_COOKIE))}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_SECONDS}${secureCookie(req)}`;
      sendJson(res, 200, { authenticated: true }, { 'Set-Cookie': cookie });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/admin/logout') {
    if (!isSameOrigin(req)) {
      sendJson(res, 403, { error: 'Запит відхилено.' });
      return;
    }
    const cookie = `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookie(req)}`;
    sendJson(res, 200, { authenticated: false }, { 'Set-Cookie': cookie });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/admin/orders') {
    if (!requireAdmin(req, res)) return;
    try {
      sendJson(res, 200, { orders: readOrders(), statement: readStatementImport() });
    } catch {
      sendJson(res, 500, { error: 'Не вдалося прочитати замовлення або виписку.' });
    }
    return;
  }

  if (req.method === 'GET' && ['/api/admin/statement.pdf', '/api/admin/statement-original.pdf'].includes(pathname)) {
    if (!requireAdmin(req, res)) return;
    const original = pathname.endsWith('statement-original.pdf');
    try {
      const bundle = readHistoryBundle();
      const contents = bundle ? Buffer.from(original ? bundle.originalPdf : bundle.pdf, 'base64')
        : fs.readFileSync(original ? STATEMENT_ORIGINAL_FILE : STATEMENT_PDF_FILE);
      send(res, 200, contents, 'application/pdf', {
        'Content-Disposition': `${original ? 'attachment' : 'inline'}; filename="${original ? 'statement-original.pdf' : 'statement.pdf'}"`,
        'X-Frame-Options': 'SAMEORIGIN'
      });
    } catch (error) {
      send(res, error.statusCode || 404, error.statusCode ? error.message : 'Виписку не знайдено.');
    }
    return;
  }

  const orderStatusRoute = pathname.match(/^\/api\/admin\/orders\/([A-Z0-9-]+)$/);
  if (req.method === 'PATCH' && orderStatusRoute) {
    if (!isSameOrigin(req)) {
      sendJson(res, 403, { error: 'Запит відхилено.' });
      return;
    }
    if (!requireAdmin(req, res)) return;
    try {
      const input = await readJsonBody(req, 2 * 1024);
      if (!ORDER_STATUSES.has(input.status)) {
        sendJson(res, 400, { error: 'Невідомий статус замовлення.' });
        return;
      }
      const orders = readOrders();
      const order = orders.find((entry) => entry.reference === orderStatusRoute[1]);
      if (!order) {
        sendJson(res, 404, { error: 'Замовлення не знайдено.' });
        return;
      }
      order.status = input.status;
      order.updatedAt = new Date().toISOString();
      writeOrders(orders);
      sendJson(res, 200, order);
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.statusCode ? error.message : 'Не вдалося оновити замовлення.' });
    }
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'Method not allowed');
    return;
  }

  const lowerPath = pathname.toLowerCase();
  if (lowerPath === '/admin' || lowerPath.startsWith('/admin/') || lowerPath === '/admin.html') {
    send(res, 404, 'Not found');
    return;
  }

  if (lowerPath === '/staff-console') {
    if (!hasAdminEntry(req) && !hasAdminSession(req)) {
      send(res, 404, 'Not found');
      return;
    }
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end();
      return;
    }
    serveFile(res, path.join(PUBLIC_DIR, 'admin.html'));
    return;
  }

  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const candidate = path.resolve(PUBLIC_DIR, relativePath);
  const insidePublic = candidate === PUBLIC_DIR || candidate.startsWith(`${PUBLIC_DIR}${path.sep}`);

  if (insidePublic && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Type': CONTENT_TYPES[path.extname(candidate)] || 'application/octet-stream' });
      res.end();
      return;
    }
    serveFile(res, candidate);
    return;
  }

  if (/^\/tovar\/[a-z0-9-]+\/?$/.test(pathname)) serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
  else send(res, 404, 'Not found');
});

fs.mkdirSync(path.dirname(ORDERS_FILE), { recursive: true });
fs.accessSync(path.dirname(ORDERS_FILE), fs.constants.W_OK);
readOrders();

server.listen(PORT, HOST, () => {
  console.log(`AUTORA is listening on http://localhost:${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
