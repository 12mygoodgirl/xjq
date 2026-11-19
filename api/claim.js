/* POST /api/claim  —— 核验付款凭证，通过后才签发解锁 token
 *
 * 关键点：URL 参数 / 用户输入的只是「待核验凭证」，不是解锁开关。
 * 这里会拿凭证去平台官方接口实时反查，查不到或没付款就不发 token。
 * 前端就算手动伪造 ?unlocked=1 也拿不到签名 token。
 *
 * 入参：{ credential: "平台订单号 或 卡密", provider: "mbd" | "afdian" }
 * 成功：{ ok:true, token:"<HMAC 签名 token>", order, amount }
 * 失败：{ ok:false, reason }  HTTP 400 / 402 / 502
 */
'use strict';
const lib = require('./_lib');
const { signToken, matchCode, afdianQueryOrder, mbdQueryOrder } = lib;

module.exports = async (req, res) => {
  const origin = process.env.ALLOW_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: false, reason: 'method not allowed' }));
  }

  const q = req.query || {};
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  if (!body || typeof body !== 'object') body = {};

  const credential = String(body.credential || q.credential || q.order || q.code || '').trim();
  const provider = String(body.provider || q.provider || process.env.PAY_PROVIDER || 'mbd').toLowerCase();
  // 'out' = 面包多独立订单号(out_order_id)，'order' = 平台订单号(order_id)；留空自动识别
  const kind = String(body.kind || q.kind || '').toLowerCase();
  const send = (status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': origin });
    res.end(JSON.stringify(obj));
  };

  if (!credential) return send(400, { ok: false, reason: '缺少订单号或解锁码' });
  if (credential.length > 128) return send(400, { ok: false, reason: '凭证格式不正确' });

  // 1) 卡密模式：平台自动发货的兑换码，命中环境变量里的码表
  if (matchCode(credential)) {
    const token = signToken({ sub: credential, typ: 'code', iat: Date.now(), exp: Date.now() + 365 * 864e5 });
    return send(200, { ok: true, token, order: credential, amount: null });
  }

  // 2) 订单号模式：向平台官方接口实时反查，确认真的付过钱
  let result;
  try {
    result = provider === 'afdian'
      ? await afdianQueryOrder(credential)
      : await mbdQueryOrder(credential, kind);
  } catch (e) {
    return send(502, { ok: false, reason: '收款平台接口暂不可用，请稍后重试' });
  }
  if (!result.paid) return send(402, { ok: false, reason: result.reason || '未查到已付款订单' });

  // 只把必要字段放进 token；平台返回的买家信息一律不下发前端
  const order = result.orderId || credential;
  const token = signToken({
    sub: order,
    typ: provider,
    via: result.via || '',
    amt: result.amount,
    iat: Date.now(),
    exp: Date.now() + 365 * 864e5
  });
  return send(200, { ok: true, token, order, amount: result.amount });
};
