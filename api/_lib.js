/* Vercel Functions 公共库（下划线开头，不会被当成独立函数部署）
 * 所有密钥只从环境变量读取，前端永远拿不到。 */
'use strict';
const crypto = require('crypto');

const E = (k, d) => (process.env[k] === undefined ? d : process.env[k]);
const MIN_AMOUNT = Number(E('MIN_AMOUNT', '19.9'));
const SECRET = E('UNLOCK_SECRET', '');

function urlSafe(s) {
  return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64url(s) {
  return urlSafe(Buffer.from(s).toString('base64'));
}

/* ---------- 签发不可伪造的解锁凭证 ---------- */
function signToken(payload) {
  if (!SECRET) throw new Error('UNLOCK_SECRET 未配置');
  const body = b64url(JSON.stringify(payload));
  const sig = urlSafe(crypto.createHmac('sha256', SECRET).update(body).digest('base64'));
  return body + '.' + sig;
}
function verifyToken(token) {
  if (!SECRET || typeof token !== 'string' || token.indexOf('.') < 0) return null;
  const [body, sig] = token.split('.');
  const expect = urlSafe(crypto.createHmac('sha256', SECRET).update(body).digest('base64'));
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64').toString('utf8'));
    if (p.exp && Date.now() > p.exp) return null;
    return p;
  } catch (e) { return null; }
}

/* ---------- 兑换码 / 卡密模式（平台自动发货的码） ---------- */
function matchCode(credential) {
  const list = E('UNLOCK_CODES', '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  return list.length > 0 && list.indexOf(String(credential).trim().toUpperCase()) >= 0;
}

/* ---------- 爱发电：官方 query-order ----------
 * 文档 https://guide.afdian.com/creator/developer
 * POST https://afdian.com/api/open/query-order
 * sign = md5(token + "params" + params + "ts" + ts + "user_id" + user_id)
 * status === 2 表示交易成功；total_amount 为真实付款金额。 */
async function afdianQueryOrder(outTradeNo) {
  const userId = E('AFDIAN_USER_ID', '');
  const token = E('AFDIAN_TOKEN', '');
  if (!userId || !token) throw new Error('缺少 AFDIAN_USER_ID / AFDIAN_TOKEN');

  const params = JSON.stringify({ out_trade_no: String(outTradeNo) });
  const ts = Math.floor(Date.now() / 1000);
  const kv = 'params' + params + 'ts' + ts + 'user_id' + userId;
  const sign = crypto.createHash('md5').update(token + kv).digest('hex');

  const r = await fetch('https://afdian.com/api/open/query-order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, params, ts, sign })
  });
  const j = await r.json();
  if (j.ec !== 200) return { paid: false, reason: '爱发电返回 ec=' + j.ec };
  const list = (j.data && j.data.list) || [];
  const o = list.find(x => String(x.out_trade_no) === String(outTradeNo));
  if (!o) return { paid: false, reason: '查不到这笔订单' };
  if (Number(o.status) !== 2) return { paid: false, reason: '订单未完成付款' };
  const amount = Number(o.total_amount);
  if (!(amount >= MIN_AMOUNT)) return { paid: false, reason: '金额未达到解锁门槛' };
  const planId = E('AFDIAN_PLAN_ID', '');
  if (planId && o.plan_id && String(o.plan_id) !== planId) return { paid: false, reason: '订单不属于本商品方案' };
  return { paid: true, amount };
}

/* ---------- 面包多：官方 order-detail ----------
 * 官方文档 https://mbd.pub/open_doc （基础 URL https://x.mbd.pub/api/）
 * GET /api/order-detail?order_id=xxx 或 ?out_order_id=xxx
 * Header: x-token: 开发者Key（原样放入，不需要编码或拼接）
 * 返回 { code:200, result:{ state:"success", orderamount:3, orderid:"...", urlkey:"..." }, error_info:"" }
 * code: 200 正常 / 403 认证失败 / 400 请求错误
 * state: success 已支付 / cancel 已取消 / invalid 已过期；回调报文里用 state:1 表示已支付
 * orderamount 为 0 表示「通过全家桶购买」
 *
 * 【独立订单号】文档 /out_order_id：引导用户到购买页时在链接后加 ?out_order_id=自定义值，
 * 平台会记录该值，付款后可用 out_order_id 反查订单状态 —— 用户无需抄平台订单号。 */
const OUT_RE = /^LTT-[A-Z0-9]+-[A-Z0-9]{12,}$/;
function isOutOrderId(s) { return OUT_RE.test(String(s)); }

async function mbdQueryOrder(orderId, kind) {
  const key = E('MBD_DEV_KEY', '');
  if (!key) throw new Error('缺少 MBD_DEV_KEY');
  // 'out' 强制按独立订单号查；'order' 强制按平台订单号查；留空则按凭证格式自动判断
  const useOut = kind === 'out' || (kind !== 'order' && isOutOrderId(orderId));
  const base = E('MBD_ORDER_API', 'https://x.mbd.pub/api/order-detail');
  const param = useOut ? 'out_order_id' : 'order_id';
  const url = base + (base.indexOf('?') >= 0 ? '&' : '?') + param + '=' + encodeURIComponent(orderId);

  const r = await fetch(url, { headers: { 'x-token': key } });
  // 实测：查无订单时平台返回 HTTP 400 + {"code":400,"error_info":"无此订单"}，
  // 这是正常业务响应（用户还没付款 / 自动轮询期间），必须按「未付款」处理，不能当服务故障。
  let j;
  try { j = await r.json(); }
  catch (e) { throw new Error('面包多接口返回非 JSON（HTTP ' + r.status + '）'); }
  if (Number(j.code) === 403) throw new Error('面包多开发者 Key 无效或已被重置');
  const info = String(j.error_info || '');
  if (j.code !== undefined && Number(j.code) !== 200) {
    const reason = /应为长度32位/.test(info) ? '请复制完整的 32 位面包多订单号'
      : (info || '面包多返回 code=' + j.code);
    return { paid: false, reason };
  }
  const d = j.result || j.data || j;
  const state = String(d.state === undefined ? j.state : d.state).toLowerCase();
  if (state !== 'success' && state !== '1' && state !== 'paid') {
    return { paid: false, reason: state === 'cancel' ? '订单已取消' : (state === 'invalid' ? '订单已过期' : '订单未完成付款') };
  }
  // 可选：只认本作品的订单，避免拿其他商品的订单号来解锁（填商品链接里的 urlkey）
  const expected = E('MBD_PRODUCT_URLKEY', '');
  if (expected && d.urlkey && String(d.urlkey) !== expected) {
    return { paid: false, reason: '订单不属于本商品' };
  }
  const amount = Number(d.orderamount !== undefined ? d.orderamount : (d.amount !== undefined ? d.amount : NaN));
  const allowBundle = String(E('ALLOW_BUNDLE', '0')) === '1'; // 全家桶订单金额为 0，默认不认
  if (!(amount >= MIN_AMOUNT) && !(allowBundle && amount === 0)) {
    return { paid: false, reason: amount === 0 ? '全家桶订单默认不解锁（如需放开设 ALLOW_BUNDLE=1）' : '金额未达到解锁门槛' };
  }
  return { paid: true, amount, orderId: d.orderid || orderId, via: useOut ? 'out_order_id' : 'order_id' };
}

module.exports = { signToken, verifyToken, matchCode, afdianQueryOrder, mbdQueryOrder, isOutOrderId, MIN_AMOUNT };
