/* 心动类型 · 收款与自动发货服务
 * 零依赖，Node.js >= 18。运行：node server/server.js
 *
 * 环境变量（见 config.example.json）：
 *   PORT              监听端口，默认 8787
 *   WEBHOOK_SECRET    收款平台回调签名密钥（必改）
 *   ADMIN_TOKEN       后台查询令牌
 *   ALLOW_ORIGIN      前端站点 Origin，正式环境务必设为你的域名
 *   ENABLE_DEMO_NOTIFY 1 = 开放 /api/pay/simulate 用于本地演示
 *   PAY_API_URL / PAY_API_KEY / MERCHANT_ID  你所选收款平台的下单接口配置
 *
 * 上线前要做的唯一一件事：把 createPayment() 里的 TODO 换成你平台的下单 API。
 * 其余（验签、幂等、发码、校验）已经可用。
 *
 * 本站不需要、也不应保存银行卡号。卡号是收款平台后台的结算账户，
 * 由经营者本人在平台后台填写；网站与前端代码全程不接触银行卡信息。
 * 「自动发货」是即时的（回调秒级）；「钱到银行卡」由平台结算周期决定（通常 T+1）。
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8787);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'dev-secret-change-me';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';
const DEMO = process.env.ENABLE_DEMO_NOTIFY === '1';
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

/* ---------- 极简持久化（生产环境请换成数据库） ---------- */
function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch (e) { return { orders: [], codes: [] }; }
}
function saveDB(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}
function newCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = crypto.randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[b[i] % chars.length];
  return 'LTT-' + s.slice(0, 4) + '-' + s.slice(4);
}
function newOrderId() {
  return 'OD' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(3).toString('hex').toUpperCase();
}

/* ---------- 下单：接你自己的收款通道 ---------- */
async function createPayment(order) {
  // TODO 替换为平台下单接口。示例：
  //   const r = await fetch(process.env.PAY_API_URL, {
  //     method:'POST',
  //     headers:{'Content-Type':'application/json','Authorization':'Bearer '+process.env.PAY_API_KEY},
  //     body: JSON.stringify({ out_trade_no: order.id, total_fee: order.amount,
  //                            title: order.product, notify_url: 'https://你的域名/api/notify' })
  //   });
  //   const d = await r.json();
  //   return { payUrl: d.pay_url, qrUrl: d.qrcode, tradeNo: d.trade_no };
  return { payUrl: null, qrUrl: null, tradeNo: null };
}

/* ---------- 发货：幂等，签名校验通过才会走到这里 ---------- */
function fulfil(db, order, tradeNo) {
  if (order.status === 'paid') return order.code;      // 重复回调不重复发码
  const code = newCode();
  order.status = 'paid';
  order.code = code;
  order.paidAt = Date.now();
  order.tradeNo = tradeNo || null;
  db.codes.push({ code, orderId: order.id, ts: Date.now() });
  return code;
}

/* ---------- HTTP helpers ---------- */
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Signature, X-Admin-Token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}
function json(res, status, obj) {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => { chunks.push(c); if (Buffer.concat(chunks).length > 1e6) reject(new Error('body too large')); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function verifySignature(raw, sig) {
  if (!sig || typeof sig !== 'string') return false;
  const expect = crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
  const a = Buffer.from(expect), b = Buffer.from(sig.toLowerCase().replace(/^sha256=/, ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon' };
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not Found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  if (req.method === 'OPTIONS') { cors(res); return res.writeHead(204).end(); }

  try {
    /* 创建订单 */
    if (p === '/api/order' && req.method === 'POST') {
      const raw = await readBody(req);
      const body = JSON.parse(raw.toString('utf8') || '{}');
      const db = loadDB();
      const order = {
        id: newOrderId(),
        product: body.product || '心动类型 · 完整解读报告',
        amount: Number(body.amount || 0),
        merchantId: body.merchantId || '',
        status: 'created', code: null, ts: Date.now()
      };
      const pay = await createPayment(order);
      order.tradeNo = pay.tradeNo || null;
      db.orders.push(order);
      saveDB(db);
      return json(res, 200, { orderId: order.id, payUrl: pay.payUrl, qrUrl: pay.qrUrl, amount: order.amount });
    }

    /* 收款平台回调：验签 → 金额校验 → 幂等发货 */
    if (p === '/api/notify' && req.method === 'POST') {
      const raw = await readBody(req);
      if (!verifySignature(raw, req.headers['x-signature'])) {
        return json(res, 401, { ok: false, error: 'invalid signature' });
      }
      let body;
      try { body = JSON.parse(raw.toString('utf8')); } catch (e) { return json(res, 400, { ok: false, error: 'bad json' }); }
      const db = loadDB();
      const order = db.orders.find(o => o.id === body.orderId);
      if (!order) return json(res, 404, { ok: false, error: 'order not found' });
      if (body.status && body.status !== 'paid' && body.status !== 'success') {
        return json(res, 200, { ok: true, status: order.status });
      }
      if (body.amount && Number(body.amount) < order.amount) {
        return json(res, 400, { ok: false, error: 'amount mismatch' });
      }
      const code = fulfil(db, order, body.tradeNo);
      saveDB(db);
      return json(res, 200, { ok: true, orderId: order.id, code });
    }

    /* 本地演示：模拟一次平台回调（仅在 ENABLE_DEMO_NOTIFY=1 时开放） */
    if (p === '/api/pay/simulate' && req.method === 'POST') {
      if (!DEMO) return json(res, 403, { ok: false, error: 'demo disabled' });
      const raw = await readBody(req);
      const body = JSON.parse(raw.toString('utf8') || '{}');
      const db = loadDB();
      const order = db.orders.find(o => o.id === body.orderId);
      if (!order) return json(res, 404, { ok: false, error: 'order not found' });
      const code = fulfil(db, order, 'DEMO-' + Date.now());
      saveDB(db);
      return json(res, 200, { ok: true, orderId: order.id, code });
    }

    /* 前端轮询：付款成功后会自动拿到解锁码 */
    if (p === '/api/order/status' && req.method === 'GET') {
      const db = loadDB();
      const order = db.orders.find(o => o.id === u.searchParams.get('order'));
      if (!order) return json(res, 404, { ok: false, error: 'order not found' });
      return json(res, 200, { status: order.status, code: order.status === 'paid' ? order.code : null });
    }

    /* 解锁码校验：正式环境的唯一可信来源 */
    if (p === '/api/verify' && req.method === 'GET') {
      const code = (u.searchParams.get('code') || '').trim().toUpperCase();
      const db = loadDB();
      const hit = db.codes.find(c => c.code === code);
      return json(res, 200, hit ? { valid: true, order: hit.orderId } : { valid: false });
    }

    /* 后台订单查询 */
    if (p === '/api/admin/orders' && req.method === 'GET') {
      if (!ADMIN_TOKEN || req.headers['x-admin-token'] !== ADMIN_TOKEN) {
        return json(res, 401, { ok: false, error: 'unauthorized' });
      }
      return json(res, 200, { orders: loadDB().orders });
    }

    if (p === '/api/health') return json(res, 200, { ok: true, demo: DEMO });

    return serveStatic(req, res, p);
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message });
  }
});

server.listen(PORT, () => {
  console.log('心动类型服务已启动: http://localhost:' + PORT);
  console.log('演示回调:', DEMO ? '开启' : '关闭（设 ENABLE_DEMO_NOTIFY=1 开启）');
  if (WEBHOOK_SECRET === 'dev-secret-change-me') console.warn('⚠ 请设置 WEBHOOK_SECRET 环境变量后再上线');
});
