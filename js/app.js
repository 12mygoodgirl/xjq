/* 心动类型测评 · 主逻辑
   demo 模式：本地预览用，付款→自动发码→自动解锁，不产生真实扣款。
   live 模式（部署在 Vercel）：点付款时生成独立订单号，拼在面包多商品链接的
   ?out_order_id= 上；用户付完切回本页，页面自动拿这个号 POST /api/claim，
   由服务端向面包多 order-detail 实时反查 → 通过后签发 HMAC token → 自动解锁。
   用户不用抄平台订单号。URL 参数只是「待核验凭证」，不是解锁开关；前端不持有任何密钥。 */
(function () {
  'use strict';

  var Q = window.QUIZ_DATA, T = window.TYPE_DATA;
  var K = { a: 'ltt_answers_v3', u: 'ltt_unlock_v3', c: 'ltt_config_v3', o: 'ltt_orders_v3', k: 'ltt_codes_v3', t: 'ltt_started_v3' };
  var mem = {};
  function get(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return mem[k] !== undefined ? mem[k] : d; } }
  function set(k, v) { mem[k] = v; try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  var PUB = window.PAY_PUBLIC || {};
  function autoMode() {
    try {
      var h = location.hostname;
      return (location.protocol === 'file:' || !h || h === 'localhost' || h === '127.0.0.1') ? 'demo' : 'live';
    } catch (e) { return 'demo'; }
  }
  var DEFAULT_CFG = {
    // 配置文件万一没加载成功，也按域名自动判定，绝不让线上误入演示模式
    mode: PUB.mode ? (PUB.mode === 'auto' ? autoMode() : PUB.mode) : autoMode(),
    price: PUB.price || 19.9,
    originPrice: 39.9,
    product: '心动类型 · 完整解读报告',
    provider: PUB.provider || 'mbd',
    productUrl: PUB.productUrl || '',
    claimApi: PUB.claimApi || '/api/claim',
    gatewayBase: 'http://localhost:8787',
    merchantId: '',
    webhookSecretHint: '仅服务端环境变量配置，前端不保存'
  };
  var savedCfg = get(K.c, {});
  var cfg = Object.assign({}, DEFAULT_CFG, savedCfg);
  // auto：本地永远演示、线上永远正式；在运营后台手动切换过模式后以你的选择为准
  if (PUB.mode === 'auto' && !savedCfg.modeLocked) cfg.mode = autoMode();
  var answers = get(K.a, []);
  var unlock = get(K.u, null);
  var orders = get(K.o, []);
  var codes = get(K.k, []);
  var state = { view: 'home', idx: 0, busy: false, claiming: false };
  var DEMO_CODE = 'LTT-DEMO-2026'; // 仅演示模式有效；正式模式自动失效
  var PENDING_KEY = 'ltt_pending_credential_v3';
  var OUT_ORDER_KEY = 'ltt_out_order_v3';   // 本地生成的面包多独立订单号
  var AUTO_MAX = 120;                       // 自动核验：3 秒一次，最长约 6 分钟
  var autoTimer = null, autoTries = 0;
  var app = document.getElementById('app');

  /* ---------------- utils ---------------- */
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function toast(msg, ms) {
    var el = document.getElementById('toast');
    el.textContent = msg; el.classList.add('on');
    clearTimeout(el._t); el._t = setTimeout(function () { el.classList.remove('on'); }, ms || 2600);
  }
  function money(n) { return '¥' + Number(n).toFixed(2); }
  function answeredCount() { var n = 0; for (var i = 0; i < Q.raw.length; i++) if (answers[i]) n++; return n; }
  function firstUnanswered() { for (var i = 0; i < Q.raw.length; i++) if (!answers[i]) return i; return -1; }
  function randomCode() {
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', s = '';
    var buf = new Uint8Array(8);
    try { crypto.getRandomValues(buf); } catch (e) { for (var j = 0; j < 8; j++) buf[j] = Math.floor(Math.random() * 256); }
    for (var i = 0; i < 8; i++) s += chars[buf[i] % chars.length];
    return 'LTT-' + s.slice(0, 4) + '-' + s.slice(4);
  }
  function orderId() { return 'OD' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase(); }
  /* 面包多独立订单号：随机到不可猜，随付款链接交给平台记录，回来用它反查
     格式 LTT-<时间戳36进制>-<16位随机>，服务端据此识别为 out_order_id。 */
  function outOrderId() {
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', buf = new Uint8Array(16), s = '';
    try { crypto.getRandomValues(buf); } catch (e) { for (var j = 0; j < 16; j++) buf[j] = Math.floor(Math.random() * 256); }
    for (var i = 0; i < 16; i++) s += chars[buf[i] % chars.length];
    return 'LTT-' + Date.now().toString(36).toUpperCase() + '-' + s;
  }
  function claimKindFor(cred) {
    return cred && /^LTT-[A-Z0-9]+-[A-Z0-9]{12,}$/.test(cred) ? 'out' : '';
  }

  /* ---------------- scoring ---------------- */
  function compute() {
    var sum = {}, cnt = {};
    Q.order.forEach(function (k) { sum[k] = 0; cnt[k] = 0; });
    Q.raw.forEach(function (r, i) {
      var v = answers[i] || 3;
      sum[r[1]] += r[2] ? (6 - v) : v;
      cnt[r[1]]++;
    });
    var sc = {};
    Q.order.forEach(function (k) { sc[k] = Math.round(sum[k] / (cnt[k] * 5) * 100); });
    var sorted = Q.order.slice().sort(function (a, b) { return sc[b] - sc[a]; });
    var pos = [], neg = [];
    Q.raw.forEach(function (r, i) { (r[2] ? neg : pos).push(answers[i] || 3); });
    function avg(a) { return a.reduce(function (x, y) { return x + y; }, 0) / a.length; }
    var pa = avg(pos), na = avg(neg);
    var consistency = Math.max(0, Math.round(100 - Math.abs(pa - (6 - na)) * 22));
    return { scores: sc, sorted: sorted, primary: sorted[0], secondary: sorted[1], consistency: consistency, straightBias: pa > 4.35 && na > 4.35 };
  }

  function radarSVG(sc) {
    var cx = 165, cy = 165, R = 112, N = 8, s = '';
    function pt(i, r) { var a = -Math.PI / 2 + i * 2 * Math.PI / N; return [cx + Math.cos(a) * r, cy + Math.sin(a) * r]; }
    function poly(r) { return Q.order.map(function (_, i) { return pt(i, r).map(function (n) { return n.toFixed(1); }).join(','); }).join(' '); }
    for (var g = 1; g <= 4; g++) s += '<polygon points="' + poly(R * g / 4) + '" fill="none" stroke="#E7DED6" stroke-width="1"/>';
    Q.order.forEach(function (_, i) { var p = pt(i, R); s += '<line x1="' + cx + '" y1="' + cy + '" x2="' + p[0].toFixed(1) + '" y2="' + p[1].toFixed(1) + '" stroke="#E7DED6" stroke-width="1"/>'; });
    var dataPts = Q.order.map(function (k, i) { return pt(i, Math.max(6, R * sc[k] / 100)); });
    s += '<polygon points="' + dataPts.map(function (p) { return p.map(function (n) { return n.toFixed(1); }).join(','); }).join(' ') + '" fill="rgba(180,96,111,.20)" stroke="#B4606F" stroke-width="2.2" stroke-linejoin="round"/>';
    dataPts.forEach(function (p) { s += '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="3.4" fill="#B4606F"/>'; });
    Q.order.forEach(function (k, i) {
      var p = pt(i, R + 27), anchor = p[0] > cx + 8 ? 'start' : (p[0] < cx - 8 ? 'end' : 'middle');
      s += '<text x="' + p[0].toFixed(1) + '" y="' + (p[1] + 4).toFixed(1) + '" text-anchor="' + anchor + '" font-size="12" fill="#5B5560">' + Q.dims[k].name + '</text>';
    });
    return '<svg class="radar" viewBox="0 0 330 330" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="八维得分雷达图">' + s + '</svg>';
  }

  /* ---------------- views ---------------- */
  function renderHome() {
    var tiles = Q.order.map(function (k) {
      return '<div class="type-tile"><img loading="lazy" src="' + T[k].image + '" alt="' + T[k].name + '"><div><b>' + T[k].name + '</b><small>' + T[k].en + '</small></div></div>';
    }).join('');
    app.innerHTML =
      '<section class="hero"><img class="hero-img" src="assets/clean/cover.png" alt="心动类型封面">' +
        '<div class="wrap hero-inner">' +
          '<div class="eyebrow">A 100-QUESTION LOVE ARCHETYPE TEST</div>' +
          '<h1 class="display">你到底会喜欢<br><em>什么样的人</em></h1>' +
          '<p>不是测你是什么样的人，是测「什么样的人会让你停下来」。100 道题，10 个章节，8 种心动原型，还有一份只属于你的完整解读。</p>' +
          '<div class="hero-actions"><button class="btn-primary btn-rose" data-action="start">' + (answeredCount() ? '继续测试 · 已答 ' + answeredCount() + '/100' : '开始测试 · 免费') + '</button>' +
          (cfg.mode === 'demo' ? '<button class="btn-line" style="border-color:rgba(255,255,255,.5);background:transparent;color:#fff" data-action="demo-fill">一键预览完整流程</button>' : '') +
          '<span class="hero-price">完整报告 <b>' + money(cfg.price) + '</b> · 答完再决定</span></div>' +
        '</div><div class="hero-badge">EST. 2026 · VOL. 01</div></section>' +
      '<div class="wrap"><div class="stats">' +
        '<div class="stat"><b>100</b><span>道情境题</span></div><div class="stat"><b>10</b><span>个章节</span></div>' +
        '<div class="stat"><b>8</b><span>种心动原型</span></div><div class="stat"><b>12</b><span>分钟左右</span></div>' +
      '</div></div>' +
      '<section class="section wrap"><div class="section-head"><div class="eyebrow">THE EIGHT ARCHETYPES</div>' +
        '<h2 class="display">你会落在哪一种里</h2><p>每个人都不止一种，但总有一种是你的底色。八张封面，对应八种被吸引的方式。</p></div>' +
        '<div class="type-grid">' + tiles + '</div></section>' +
      '<section class="section wrap" style="padding-top:0"><div class="steps">' +
        '<div class="step card"><i>01</i><h3>答完 100 题</h3><p>按第一反应选就好，没有对错。进度会自动保存，中途退出也能接着答。</p></div>' +
        '<div class="step card"><i>02</i><h3>看到你的主型</h3><p>交卷后立刻显示你的心动原型和八维得分轮廓，这部分免费。</p></div>' +
        '<div class="step card"><i>03</i><h3>解锁完整解读</h3><p>付款后系统自动发放解锁码，无需等待、无需人工，报告当场打开。</p></div>' +
      '</div></section>' +
      '<section class="section wrap" style="padding-top:0"><div class="pay-note">' +
        '<div><h3 class="display">关于「自动发货」</h3><p>付款在面包多 / 爱发电完成。付完回到本页，带上订单号或平台发的兑换码，服务端会向平台官方接口实时核验，确认收款后当场解锁报告——不需要人工发码，也不需要把任何密钥交给网页。</p></div>' +
        '<button class="btn-primary" data-action="go-pay">查看解锁方式 →</button></div></section>';
  }

  function renderQuiz(flash) {
    var i = state.idx, row = Q.raw[i], g = Q.groups[Math.floor(i / 10)];
    var opts = Q.options.map(function (label, n) {
      var v = n + 1;
      return '<button class="opt' + (answers[i] === v ? ' sel' : '') + '" data-action="answer" data-v="' + v + '"><span class="num">' + ['①', '②', '③', '④', '⑤'][n] + '</span>' + label + '</button>';
    }).join('');
    var done = answeredCount();
    app.innerHTML =
      '<div class="quiz-shell">' +
        '<div class="quiz-top"><div class="quiz-chapter">' + (Math.floor(i / 10) + 1) + ' · ' + g.name + '<small>' + g.sub + '</small></div>' +
          '<div class="quiz-count"><b>' + (i + 1) + '</b>/ 100</div></div>' +
        '<div class="progress"><i style="width:' + done + '%"></i></div>' +
        '<div class="dots">' + Q.groups.map(function (_, n) { return '<span class="' + (Math.floor(i / 10) >= n ? 'on' : '') + '"></span>'; }).join('') + '</div>' +
        '<div class="qcard card"><div class="qindex">QUESTION ' + String(i + 1).padStart(3, '0') + '</div>' +
          '<h2 class="qtext">' + esc(row[0]) + '</h2><div class="opts">' + opts + '</div></div>' +
        '<div class="quiz-foot"><span class="quiz-tip">按第一反应选 · 每题自动跳下一题 · 已答 ' + done + '/100</span>' +
          '<div class="quiz-nav"><button class="btn-line" data-action="prev"' + (i === 0 ? ' disabled' : '') + '>上一题</button>' +
          '<button class="btn-line" data-action="next">下一题</button>' +
          (done === 100 ? '<button class="btn-primary" data-action="submit" style="padding:11px 22px">交卷看结果</button>' : '') + '</div></div>' +
      '</div>';
    if (flash) {
      var f = document.createElement('div');
      f.className = 'chapter-flash';
      f.innerHTML = '<b>' + g.name + '</b><span>' + g.sub + '</span>';
      document.body.appendChild(f);
      setTimeout(function () { f.remove(); }, 1100);
    }
  }

  function renderPaywall() {
    if (answeredCount() < 100) { state.view = 'quiz'; state.idx = firstUnanswered(); return renderQuiz(); }
    var r = compute(), p = T[r.primary];
    app.innerHTML =
      '<div class="paywall"><div class="pw-head"><div class="eyebrow">YOUR RESULT IS READY</div>' +
        '<h2 class="display">你的心动类型已经算出来了</h2><p>主型与八维轮廓现在就能看；完整解读需要解锁。</p></div>' +
        '<div class="pw-grid">' +
          '<div class="preview"><img src="' + p.image + '" alt=""><div class="preview-inner">' +
            '<span class="lock">🔒 未解锁</span><h3 class="display">' + p.name + '</h3><p>' + p.tagline + '</p>' +
            '<div class="blur-lines"><i></i><i></i><i></i></div>' +
            '<div style="margin-top:20px;font-size:12px;letter-spacing:.1em;opacity:.8">' + p.en + '</div></div></div>' +
          '<div class="pay-card card"><h3 class="display">完整解读报告</h3><p class="sub">一次付款 · 永久有效 · 自动发货</p>' +
            '<div class="price-row"><b>' + money(cfg.price) + '</b><s>' + money(cfg.originPrice) + '</s><span>单次解锁</span></div>' +
            '<ul class="includes">' +
              '<li>你的主型深度画像：心动机制、盲点与代价</li>' +
              '<li>八维完整得分雷达图与逐项解读</li>' +
              '<li>主型 × 辅型的双主线组合分析</li>' +
              '<li>「你会喜欢的人」与「容易消耗你的人」清单</li>' +
              '<li>3 条针对你的具体相处建议</li>' +
              '<li>可打印 / 保存，随时回看</li></ul>' +
            '<button class="btn-primary btn-rose" data-action="pay" id="payBtn">' + (cfg.mode === 'demo' ? '模拟付款并解锁' : '前往付款 ' + money(cfg.price)) + '</button>' +
            '<div class="code-row"><input id="codeInput" placeholder="' + (cfg.mode === 'demo' ? '已有解锁码？输入后直接查看' : '付款后粘贴平台订单号 / 兑换码') + '" autocomplete="off"><button class="btn-line" data-action="verify-code">' + (cfg.mode === 'demo' ? '解锁' : '核验并解锁') + '</button></div>' +
            (cfg.mode === 'demo'
              ? '<div class="demo-strip"><span>演示解锁码 <b style="color:#B4606F;letter-spacing:.08em">' + DEMO_CODE + '</b>（仅演示模式有效）</span><button data-action="fill-demo-code">填入并解锁</button></div>' +
                '<div class="demo-strip"><span>当前为演示模式：付款与发货在本地模拟，不会产生真实扣款。</span><button data-action="demo-notify">模拟平台回调发货</button></div>'
              : '<div class="demo-strip"><span>付款在面包多完成。<b>付完切回本页，报告自动解锁</b>，不用抄订单号 —— 本页会拿独立订单号向平台反查。</span><button data-action="claim-pending">立即检查付款状态</button></div>' +
                '<div class="demo-strip"><span>也可以粘贴面包多订单号手动核验。URL 参数只是待核验凭证，服务端一律向平台反查，伪造 ?unlocked=1 无效。</span></div>') +
          '</div></div></div>';
    // 从付款页带回来的凭证：自动核验一次，用户不用再点
    var pending = (cfg.mode === 'live' && !unlock) ? (get(OUT_ORDER_KEY, '') || get(PENDING_KEY, '')) : null;
    if (pending) {
      if (!state.claiming) {
        state.claiming = true;
        var box = document.getElementById('codeInput');
        if (box) box.value = pending;
        claimUnlock(pending, true, claimKindFor(pending)).then(function () { state.claiming = false; });
      }
      startAutoClaim(pending); // 持续反查，付款完成即自动解锁
    }
  }

  function renderReport() {
    var r = compute(), p = T[r.primary], s = T[r.secondary];
    var bars = Q.order.map(function (k) {
      var v = r.scores[k];
      return '<div class="bar-item"><span>' + Q.dims[k].name + '</span><div class="bar-track"><i style="width:' + v + '%;background:' + Q.dims[k].color + '"></i></div><b>' + v + '</b></div>';
    }).join('');
    function list(arr, cls) { return '<ul class="tag-list ' + (cls || '') + '">' + arr.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>'; }
    app.innerHTML =
      '<div class="report"><div class="report-hero"><img src="' + p.image + '" alt="' + p.name + '"><div class="wrap report-hero-inner">' +
        '<div class="eyebrow">YOUR LOVE ARCHETYPE · ' + p.en + '</div><h1 class="display">' + p.name + '</h1><p>' + p.tagline + '</p></div></div>' +
      '<div class="report-body">' +
        '<div class="report-card card"><div class="rc-head"><i></i><h2>你的八维心动轮廓</h2><span>100 题 · 8 维</span></div>' +
          '<div class="radar-row">' + radarSVG(r.scores) + '<div class="bars">' + bars + '</div></div></div>' +
        '<div class="report-card card portrait"><div class="rc-head"><i></i><h2>关于「' + p.name + '」</h2><span>DEEP PORTRAIT</span></div>' +
          '<div class="kw">' + p.keywords.map(function (k) { return '<span>' + k + '</span>'; }).join('') + '</div>' +
          p.portrait.map(function (t) { return '<p>' + esc(t) + '</p>'; }).join('') +
          '<div class="combo"><b>你的双主线：</b>底色是「' + p.name + '」，同时「' + s.name + '」占了 ' + r.scores[r.secondary] + '% 的比重。' + s.blend +
          (r.scores[r.primary] - r.scores[r.secondary] < 5 ? ' 两者分数很接近，说明你不是单一类型，会随对象和阶段切换模式。' : '') + '</div></div>' +
        '<div class="two-col">' +
          '<div class="report-card card"><div class="rc-head"><i></i><h2>你会喜欢的人</h2></div>' + list(p.green) + '</div>' +
          '<div class="report-card card"><div class="rc-head"><i></i><h2>容易消耗你的人</h2></div>' + list(p.red, 'red') + '</div></div>' +
        '<div class="report-card card"><div class="rc-head"><i></i><h2>给你的三条建议</h2></div>' + list(p.advice) +
          '<div class="mini-stats" style="margin-top:26px"><div><b>100</b><span>已完成题目</span></div>' +
          '<div><b>' + r.scores[r.primary] + '%</b><span>主型强度</span></div>' +
          '<div><b>' + r.consistency + '%</b><span>作答一致性</span></div></div>' +
          (r.straightBias ? '<p class="caveat" style="margin-top:16px">提示：你在正向题和反向题上都倾向选「非常像我」，结果可能略有偏差，可重新作答一次。</p>' : '') +
        '</div>' +
        '<div class="report-foot"><div class="caveat">本报告基于你在 100 道情境题中的自评生成，用于自我探索与趣味参考，不构成心理诊断，也不预测具体关系的结果。解锁码：' + esc(unlock && unlock.code ? unlock.code : '—') + '</div>' +
          '<div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn-line" data-action="print">打印 / 存为 PDF</button><button class="btn-line" data-action="restart">重新测试</button></div></div>' +
      '</div></div>';
  }

  /* ---------------- payment / fulfilment ---------------- */
  function grant(code, order, extra) {
    unlock = Object.assign({ code: code, order: order, ts: Date.now() }, extra || {});
    set(K.u, unlock);
    state.view = 'report';
    window.scrollTo(0, 0);
    renderReport();
    toast('付款已确认，报告已自动发放 ✓', 3200);
  }

  function fulfilLocal(order) {
    var code = randomCode();
    var rec = orders.find(function (x) { return x.id === order; });
    if (rec) { rec.status = 'paid'; rec.code = code; }
    else orders.unshift({ id: order, amount: cfg.price, status: 'paid', code: code, ts: Date.now() });
    codes.push(code);
    set(K.o, orders); set(K.k, codes);
    grant(code, order);
  }

  function pay() {
    if (state.busy) return;
    if (cfg.mode === 'demo') {
      state.busy = true;
      var btn = document.getElementById('payBtn');
      if (btn) { btn.disabled = true; btn.textContent = '正在确认付款…'; }
      var oid = orderId();
      setTimeout(function () {
        state.busy = false;
        orders.unshift({ id: oid, amount: cfg.price, status: 'created', ts: Date.now() });
        set(K.o, orders);
        fulfilLocal(oid);
      }, 850);
      return;
    }
    startPlatformPurchase();
  }

  /* 正式模式：跳到面包多 / 爱发电的商品页付款
     面包多官方机制：购买链接加 ?out_order_id=自定义值，平台把它记在订单上；
     付款后用该值调 order-detail 反查，用户不必抄平台订单号。 */
  function startPlatformPurchase() {
    if (!cfg.productUrl || cfg.productUrl.indexOf('REPLACE_WITH_YOUR_PRODUCT') >= 0) {
      toast('请先在 js/pay-config.js 里填上你的商品链接', 4200); return;
    }
    var cid = cfg.provider === 'mbd' ? outOrderId() : orderId();
    set(OUT_ORDER_KEY, cid);
    set(PENDING_KEY, cid);
    orders.unshift({ id: cid, amount: cfg.price, status: 'redirected', ts: Date.now() });
    set(K.o, orders);
    var url = cfg.productUrl;
    try {
      var u = new URL(url, location.href);
      u.searchParams.set(cfg.provider === 'mbd' ? 'out_order_id' : 'ref', cid);
      url = u.toString();
    } catch (e) {
      url = url + (url.indexOf('?') >= 0 ? '&' : '?') + (cfg.provider === 'mbd' ? 'out_order_id=' : 'ref=') + encodeURIComponent(cid);
    }
    window.open(url, '_blank');
    toast(cfg.provider === 'mbd'
      ? '已打开付款页。付完切回本页，报告会自动解锁，不用抄订单号'
      : '已打开付款页。付完切回本页，粘贴订单号后自动核验', 4800);
    startAutoClaim(cid);
  }

  /* 付款页在另一个标签：停留期间每 3 秒反查一次，切回标签页立刻查一次。
     查到已付款 → 服务端签发 token → 报告当场打开，全程无需用户操作。 */
  function startAutoClaim(cred) {
    if (cfg.mode !== 'live' || unlock || !cred) return;
    stopAutoClaim();
    autoTries = 0;
    var tick = function () {
      if (unlock || autoTries >= AUTO_MAX) { stopAutoClaim(); return; }
      if (document.hidden || state.claiming) return;
      autoTries++;
      claimUnlock(cred, true, claimKindFor(cred)).then(function (ok) {
        if (ok) stopAutoClaim();
      });
    };
    autoTimer = setInterval(tick, 3000);
    tick();
  }
  function stopAutoClaim() { if (autoTimer) { clearInterval(autoTimer); autoTimer = null; } }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden || cfg.mode !== 'live' || unlock) return;
    var cred = get(OUT_ORDER_KEY, '') || get(PENDING_KEY, '');
    if (cred) startAutoClaim(cred);
  });

  /* 服务端核验：订单号 / 卡密 → 平台官方接口反查 → 签发签名 token */
  async function claimUnlock(credential, quiet, kind) {
    credential = String(credential || '').trim();
    if (!credential) { if (!quiet) toast('请输入平台订单号或兑换码'); return false; }
    try {
      var res = await fetch(cfg.claimApi, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential: credential, provider: cfg.provider, kind: kind || '' })
      });
      var d = await res.json();
      if (d.ok && d.token) {
        set(PENDING_KEY, null); set(OUT_ORDER_KEY, null); stopAutoClaim();
        orders.unshift({ id: d.order || credential, amount: d.amount || cfg.price, status: 'paid', code: credential, ts: Date.now() });
        set(K.o, orders);
        grant(credential, d.order || credential, { token: d.token, provider: cfg.provider, amount: d.amount });
        return true;
      }
      if (!quiet) toast(d.reason ? '核验未通过：' + d.reason : '暂未查到已付款订单，请稍后重试', 4000);
    } catch (e) {
      if (!quiet) toast('核验服务不可用：请确认已部署 /api/claim 并配好环境变量', 4200);
    }
    return false;
  }

  async function verifyCode(code) {
    var raw = String(code || '').trim();
    if (!raw) { toast('请先输入订单号或兑换码'); return; }
    // 正式模式保留原始大小写：面包多订单号含小写字母，不能 toUpperCase
    if (cfg.mode === 'live') { await claimUnlock(raw); return; }
    var norm = raw.toUpperCase();
    if (norm === DEMO_CODE) { grant(norm, 'DEMO-PREVIEW'); return; }
    var rec = orders.find(function (o) { return o.code === norm; });
    if (codes.indexOf(norm) >= 0) grant(norm, rec ? rec.id : '—');
    else toast('解锁码无效：本机会话中未发放过这个码');
  }

  /* ---------------- admin ---------------- */
  function renderAdmin() {
    var root = document.getElementById('adminRoot');
    var list = orders.length ? orders.map(function (o) { return o.id + '  ' + o.status + '  ' + money(o.amount) + '  ' + (o.code || '—'); }).join('\n') : '（暂无订单）';
    root.innerHTML =
      '<div class="admin" id="adminMask"><div class="admin-box">' +
        '<div style="display:flex;justify-content:space-between;align-items:center"><h2 class="display">运营后台</h2><button class="btn-line" data-action="admin-close">关闭</button></div>' +
        '<p class="hint">地址栏加 ?admin=1 可再次打开 · 配置保存在本机浏览器</p>' +
        '<div class="field"><label>收款模式</label><select id="cfgMode"><option value="demo"' + (cfg.mode === 'demo' ? ' selected' : '') + '>演示模式（本地模拟付款与发货）</option><option value="live"' + (cfg.mode === 'live' ? ' selected' : '') + '>正式模式（走服务端校验）</option></select></div>' +
        '<div class="field"><label>解锁价格（元）</label><input id="cfgPrice" type="number" step="0.1" value="' + cfg.price + '"></div>' +
        '<div class="field"><label>划线原价（元）</label><input id="cfgOrigin" type="number" step="0.1" value="' + cfg.originPrice + '"></div>' +
        '<div class="field"><label>商品名称</label><input id="cfgProduct" value="' + esc(cfg.product) + '"></div>' +
        '<div class="field"><label>收款平台</label><select id="cfgProvider"><option value="mbd"' + (cfg.provider === 'mbd' ? ' selected' : '') + '>面包多</option><option value="afdian"' + (cfg.provider === 'afdian' ? ' selected' : '') + '>爱发电</option></select></div>' +
        '<div class="field"><label>商品 / 方案链接</label><input id="cfgProductUrl" value="' + esc(cfg.productUrl) + '" placeholder="https://..."><small>买家点「前往付款」会跳到这里；部署时改 js/pay-config.js 更省事。</small></div>' +
        '<button class="btn-primary" data-action="admin-save" style="width:100%;padding:12px">保存配置</button>' +
        '<div class="admin-sec"><h3>Vercel 部署 · 环境变量清单</h3>' +
          '<div class="warn" style="margin:0 0 16px;background:#F9EAEA;border-color:#E9C6C6;color:#8C4C55"><b>银行卡号不用给，也别给。</b>卡号只是平台后台的结算账户，由你自己填。同样不要提供支付密码、短信验证码、身份证照片或网银登录信息。</div>' +
          '<div style="font-size:12px;color:#5B5560;line-height:1.9;margin-bottom:12px">在 Vercel 项目 Settings → Environment Variables 里配置，改完重新部署：</div>' +
          '<div class="admin-list" style="line-height:2;margin-bottom:14px">' +
            'UNLOCK_SECRET = 随机长字符串（签发 token，必填）<br>' +
            'PAY_PROVIDER = mbd 或 afdian<br>' +
            'MIN_AMOUNT = 19.9（解锁金额门槛）<br>' +
            'MBD_DEV_KEY = 面包多开发者Key<br>' +
            'AFDIAN_USER_ID / AFDIAN_TOKEN = 爱发电开发者后台<br>' +
            'AFDIAN_PLAN_ID = 可选，限定方案 ID<br>' +
            'MBD_PRODUCT_URLKEY = 可选，只认本作品的订单<br>' +
            'ALLOW_BUNDLE = 可选，1 表示允许全家桶订单<br>' +
            'UNLOCK_CODES = 可选，逗号分隔的卡密' +
          '</div>' +
          '<div style="font-size:12px;color:#5B5560;line-height:1.9"><b>面包多自动解锁是怎么做到的：</b>点「前往付款」时本页生成一个随机独立订单号，拼成 <b>?out_order_id=…</b> 附在商品链接上，平台会把它记进订单。买家付完切回本页，页面自动拿这个号请求 /api/claim，服务端调官方 order-detail 反查，确认 <b>code=200、state=success、金额达标</b> 才签发签名 token 并打开报告 —— 不用抄订单号、不用 Webhook、不用数据库。也支持粘贴平台订单号或 <b>?order=</b> 带回核验。钱由平台结算到你的银行卡（通常 T+1），不是付款瞬间到卡。</div>' +
        '</div>' +
        '<div class="admin-sec"><h3>手动发放解锁码</h3><div class="admin-list" id="codeOut">（点下方按钮生成）</div>' +
          '<div class="admin-row"><button class="btn-line" data-action="gen-code">生成一个解锁码</button><button class="btn-line" data-action="copy-code">复制</button></div></div>' +
        '<div class="admin-sec"><h3>订单记录</h3><div class="admin-list" id="orderList">' + esc(list).replace(/\n/g, '<br>') + '</div>' +
          '<div class="admin-row"><button class="btn-line" data-action="clear-data">清空本机数据</button></div></div>' +
        '<div class="warn"><b>上线前必读：</b>URL 参数只是待核验凭证，服务端 /api/claim 会向平台官方接口反查，查不到或未付款就不发签名 token。静态站里报告文案仍在前端源码中，付费墙挡得住普通访客、挡不住查看源码的人；要彻底保护内容，需把付费文案也移到服务端按 token 返回。钱由平台结算到你的银行卡，网页不接触银行卡。</div>' +
      '</div></div>';
  }

  /* ---------------- events ---------------- */
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-action]');
    if (!el) return;
    var a = el.getAttribute('data-action');
    if (a === 'home') { state.view = 'home'; window.scrollTo(0, 0); renderHome(); return; }
    if (a === 'start') {
      if (!get(K.t, null)) set(K.t, Date.now());
      state.view = 'quiz';
      var f = firstUnanswered(); state.idx = f < 0 ? 0 : f;
      window.scrollTo(0, 0); renderQuiz(); return;
    }
    if (a === 'demo-fill') {
      var pattern = [5, 4, 2, 5, 3, 4, 5, 2, 4, 5, 3, 5, 4, 2, 5, 4, 3, 5, 2, 4];
      answers = Q.raw.map(function (_, i) { return pattern[i % pattern.length]; });
      set(K.a, answers);
      document.getElementById('adminRoot').innerHTML = '';
      state.view = 'paywall'; window.scrollTo(0, 0); renderPaywall();
      toast('已填入 100 道演示答案，可直接体验付款与自动发货');
      return;
    }
    if (a === 'go-pay') { state.view = unlock ? 'report' : 'paywall'; window.scrollTo(0, 0); unlock ? renderReport() : renderPaywall(); return; }
    if (a === 'answer') {
      var v = +el.getAttribute('data-v');
      answers[state.idx] = v; set(K.a, answers);
      var prevChapter = Math.floor(state.idx / 10);
      if (state.idx < Q.raw.length - 1) {
        state.idx++;
        renderQuiz(Math.floor(state.idx / 10) !== prevChapter);
      } else {
        renderQuiz();
        if (answeredCount() === 100) { state.view = 'paywall'; window.scrollTo(0, 0); renderPaywall(); }
      }
      return;
    }
    if (a === 'prev') { if (state.idx > 0) { state.idx--; renderQuiz(); } return; }
    if (a === 'next') {
      if (state.idx < Q.raw.length - 1) { state.idx++; renderQuiz(); }
      else { var u = firstUnanswered(); if (u >= 0) { state.idx = u; renderQuiz(); toast('还有 ' + (100 - answeredCount()) + ' 题未答'); } }
      return;
    }
    if (a === 'submit') {
      var un = firstUnanswered();
      if (un >= 0) { state.idx = un; renderQuiz(); toast('请先答完第 ' + (un + 1) + ' 题'); return; }
      state.view = 'paywall'; window.scrollTo(0, 0); renderPaywall(); return;
    }
    if (a === 'pay') { pay(); return; }
    if (a === 'demo-notify') {
      var od = orderId();
      orders.unshift({ id: od, amount: cfg.price, status: 'notify-received', ts: Date.now() });
      set(K.o, orders);
      toast('收到平台回调：验签通过 → 生成解锁码 → 自动发货', 2200);
      setTimeout(function () { fulfilLocal(od); }, 700);
      return;
    }
    if (a === 'fill-demo-code') {
      var ci = document.getElementById('codeInput');
      if (ci) ci.value = DEMO_CODE;
      verifyCode(DEMO_CODE);
      return;
    }
    if (a === 'claim-pending') {
      var pendingInput = document.getElementById('codeInput');
      var cred = (pendingInput && pendingInput.value.trim()) || get(OUT_ORDER_KEY, '') || get(PENDING_KEY, '');
      if (!cred) { toast('请先粘贴平台订单号，或重新点一次「前往付款」', 4200); return; }
      claimUnlock(cred, false, claimKindFor(cred));
      return;
    }
    if (a === 'verify-code') { verifyCode(document.getElementById('codeInput').value); return; }
    if (a === 'print') { window.print(); return; }
    if (a === 'restart') {
      if (!confirm('重新测试会清空本次 100 题的答案（已解锁状态保留），确定吗？')) return;
      answers = []; set(K.a, answers); state.view = 'quiz'; state.idx = 0; window.scrollTo(0, 0); renderQuiz(); return;
    }
    if (a === 'admin-close') { document.getElementById('adminRoot').innerHTML = ''; return; }
    if (a === 'admin-save') {
      cfg.mode = document.getElementById('cfgMode').value;
      cfg.modeLocked = true; // 手动切换过模式后，不再由 auto 覆盖
      cfg.price = +document.getElementById('cfgPrice').value || cfg.price;
      cfg.originPrice = +document.getElementById('cfgOrigin').value || cfg.originPrice;
      cfg.product = document.getElementById('cfgProduct').value || cfg.product;
      cfg.provider = document.getElementById('cfgProvider').value;
      cfg.productUrl = document.getElementById('cfgProductUrl').value || cfg.productUrl;
      set(K.c, cfg); toast('配置已保存');
      state.view === 'paywall' ? renderPaywall() : renderHome(); return;
    }
    if (a === 'gen-code') {
      var c = randomCode(); codes.push(c); set(K.k, codes);
      orders.unshift({ id: 'MANUAL-' + Date.now().toString(36).toUpperCase(), amount: 0, status: 'manual', code: c, ts: Date.now() });
      set(K.o, orders);
      document.getElementById('codeOut').textContent = c; toast('解锁码已生成：' + c); renderAdminList(); return;
    }
    if (a === 'copy-code') {
      var txt = document.getElementById('codeOut').textContent;
      if (txt && txt.indexOf('LTT-') === 0) { try { navigator.clipboard.writeText(txt); toast('已复制'); } catch (er) { toast(txt); } }
      else toast('请先生成一个解锁码'); return;
    }
    if (a === 'clear-data') {
      if (!confirm('将清空本机答案、订单、解锁码与解锁状态，且不可恢复。确定吗？')) return;
      Object.keys(K).forEach(function (k) { try { localStorage.removeItem(K[k]); } catch (er) {} });
      answers = []; unlock = null; orders = []; codes = []; cfg = Object.assign({}, DEFAULT_CFG);
      document.getElementById('adminRoot').innerHTML = '';
      state.view = 'home'; renderHome(); toast('本机数据已清空'); return;
    }
  });

  function renderAdminList() {
    var box = document.getElementById('orderList');
    if (!box) return;
    box.innerHTML = esc(orders.map(function (o) { return o.id + '  ' + o.status + '  ' + money(o.amount) + '  ' + (o.code || '—'); }).join('\n')).replace(/\n/g, '<br>');
  }

  document.addEventListener('keydown', function (e) {
    if (state.view !== 'quiz' || !e.key.match(/^[1-5]$/)) return;
    if (document.querySelector('.admin')) return;
    var v = +e.key;
    var btn = document.querySelector('.opt[data-v="' + v + '"]');
    if (btn) btn.click();
  });

  /* ---------------- boot ---------------- */
  function boot() {
    if (unlock) state.view = 'report';
    if (state.view === 'report' && answeredCount() === 100) renderReport();
    else if (state.view === 'report') { state.view = 'home'; renderHome(); }
    else renderHome();
    if (/[?&]admin=1/.test(location.search)) renderAdmin();
    document.getElementById('navUnlock').textContent = unlock ? '查看我的报告' : '解锁完整报告';

    // 平台「付款后返回」带回来的凭证：?order= / ?credential= / ?code=
    // 只当作待核验凭证存起来，立刻从地址栏抹掉，绝不把它当解锁开关。
    if (cfg.mode === 'live' && !unlock) {
      try {
        var q = new URLSearchParams(location.search);
        var cred = q.get('order') || q.get('credential') || q.get('code');
        if (cred) {
          set(PENDING_KEY, cred);
          if (answeredCount() === 100) { state.view = 'paywall'; renderPaywall(); }
          else toast('检测到付款凭证，答完 100 题后会自动解锁', 4200);
          q.delete('order'); q.delete('credential'); q.delete('code');
          history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q.toString() : '') + location.hash);
        }
      } catch (e) { /* file:// 或旧浏览器不支持时忽略 */ }

      // 之前点过「前往付款」但还没确认：回来时直接进付费墙，自动继续反查
      var waiting = get(OUT_ORDER_KEY, '') || get(PENDING_KEY, '');
      if (waiting && answeredCount() === 100 && state.view !== 'paywall') {
        state.view = 'paywall'; renderPaywall();
      }
    }
  }
  boot();
})();
