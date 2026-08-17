/* 股票工作台前端控制器 */
/* r40 版本自检：K线区改为 ECharts 双标签（【分时】折线面积图 / 【日K+指标】蜡烛图），两套 series 完全独立（setOption(opt,true) 不合并），背景 #121214，涨红 #ff4c4c 跌绿 #36d170（A股统一），分时 1 根金黄 MA #ffc120，日K MA5金/MA10蓝 #3488eb/MA20灰 #aaaaaa，量能随涨跌，接口空时演示数据兜底。 */
console.log('%c[wb] app.js r40q loaded (视图1+视图2 信号扫描/尾盘双面板 + errToast 去重)','color:#ef4444;font-weight:bold');
if (window.__WB_VERSION__ && window.__WB_VERSION__ !== 'r40q') {
  console.warn('[wb] HTML/JS 版本不一致！HTML=' + window.__WB_VERSION__ + ' JS=r40q。请强制刷新或清缓存。');
}
(function () {
  /* 用函数声明(而非 const=箭头函数)避免 TDZ；并把所有 selector 失败的情况用 stub-div
     兜底——任何 $("#nonexistent").addEventListener 都变成 no-op，不再 throw 让整页 init 中断 */
  const _docQuery = (s) => { try { return document.querySelector(s); } catch (e) { return null; } };
  let _stubEl = null;
  function $(s) {
    const el = _docQuery(s);
    if (el) return el;
    if (!_stubEl) _stubEl = document.createElement('div');
    return _stubEl;
  }
  /* 把启动期错误抛到页面顶部红条（不用开 F12 也能看到）
     r40q：去重 + 上限，避免反复 append 堆成屎山 */
  const _errToastSeen = new Set();
  const _ERR_TOAST_MAX = 8;
  function _showErrAtTop(label, info) {
    try {
      const bar = document.getElementById('errToast');
      if (!bar) return;
      const txt = (info && info.stack) ? info.stack : String(info || '');
      const key = label + '|' + txt.slice(0, 200);
      if (_errToastSeen.has(key)) return;            // 同源错误只显示一次
      _errToastSeen.add(key);
      // 超过上限就清空从头开始
      const lines = (bar.textContent || '').split('\n---\n').filter(Boolean);
      if (lines.length >= _ERR_TOAST_MAX) lines.splice(0, lines.length - _ERR_TOAST_MAX + 1);
      lines.push('[' + label + '] ' + txt.slice(0, 1500));
      bar.textContent = lines.join('\n---\n') + '\n---\n';
      bar.style.display = 'block';
    } catch (e) { /* ignore */ }
  }
  window.addEventListener('error', (ev) => _showErrAtTop('onerror @ ' + (ev.filename||'?') + ':' + (ev.lineno||'?') + ':' + (ev.colno||'?'), ev.error || ev.message));
  window.addEventListener('unhandledrejection', (ev) => _showErrAtTop('unhandledrejection', ev.reason));
  let API_BASE = localStorage.getItem("wb_api_base") || "";
  /* 用函数声明(而非 const=箭头函数)避免 TDZ：函数声明+初始化同步完成，任何调用点都不会触发
     "Can't access lexical declaration 'api' before initialization" */
  async function api(method, url, body) {
    const build = (base) => {
      const u = base ? (base.replace(/\/$/, "") + url) : url;
      const opt = { method, headers: { "Content-Type": "application/json" } };
      if (body) opt.body = JSON.stringify(body);
      return fetch(u, opt);
    };
    let r, usedBase = API_BASE;
    try {
      r = await build(API_BASE);
    } catch (e) {
      if (API_BASE) { r = await build(""); usedBase = ""; }
      else throw new Error("网络异常：" + (e && e.message || e) + "（请检查服务是否启动）");
    }
    if (API_BASE && !r.ok) {
      const r2 = await build("");
      if (r2.ok) { r = r2; usedBase = ""; }
    }
    if (!r.ok) throw new Error("服务暂时不可用（HTTP " + r.status + " " + r.statusText + "），稍后重试");
    return r.json();
  }
  const ACT_COLOR = {
    "强烈买入": "#c92a2a", "买入": "#e03131", "持有": "#868e96",
    "减仓": "#2f9e44", "卖出": "#2b8a3e",
  };
  const PERIOD_LABEL = { "1m": "分时", "5m": "5分", "15m": "15分", "30m": "30分", "60m": "60分", "daily": "日线", "weekly": "周线" };

  const state = {
    current: { code: "", name: "", period: "daily" },
    watchlist: [],
    watchMeta: {},   // code -> {price, change, change_pct, action, score}
    candidates: [],  // 自动优选（候选扫描）结果
    positions: [],   // [{code, name, shares, cost}]
    posAdvice: [],   // 批量持仓建议（买/卖/不动 + 操作价 + 操作量 + 行业强弱）
    sentiment: null, // 大盘全局情绪（/api/market_sentiment）
    lastKline: null,
    timers: [],
  };

  let chart;  // 保留空引用，旧函数检测不到 chart 元素就安全跳过

  function toast(msg, sec = 3) {
    const t = $("#toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), sec * 1000);
  }

  // 账户 + AI 建议（账户总览+持仓 dashboard）取一次 /api/positions_advice，
  // 同时算出 4 个大字 KPI（现金来自后端账户数据/截图，当日盈亏为真实账户级差值）、
  // 渲染持仓表、渲染 AI 建议卡片、回填当日交易录入的代码下拉。
  async function renderAccount() {
    try {
      // 提速：先显示缓存，再用最新结果覆盖；避免冷启动时 sector_strength/K线拉取阻塞页面
      if (state.posAdvice && state.posAdvice.length) {
        renderPosTable(state.posAdvice);
        renderAiAdvice(state.posAdvice);
      }
      const t0 = Date.now();
      const d = await api("GET", "/api/positions_advice");
      const took = Date.now() - t0;
      // 如果接口本身报错（d.error）或没 ok，弹出来给用户看，避免页面"看着没了持仓"误判
      if (!d) {
        showAccountErr("无响应", "接口没返回，请点 🔄 重试");
        return;
      }
      if (!d.ok) {
        showAccountErr("加载失败", (d.error || "接口 ok=false"));
        return;
      }
      const positions = d.positions || [];
      state.posAdvice = positions;
      // 调试锚点：把后端实际返回塞到 window.__lastD 和页面调试栏，王总 F12 一眼能看到接口真实数据
      window.__lastD = d;
      try {
        const dbg = document.getElementById("__posDebug");
        if (dbg) dbg.textContent = `接口返回 ok=${d.ok} count=${(d.positions||[]).length} cash=${d.cash} mv=${d.market_value} tv=${d.total_value} 取自 ${(d._served_at||'')}`;
      } catch (_) {}

      const cash = +(d.cash || 0);
      const mv = +(d.market_value || 0);
      const asset = +(d.total_value || 0);
      const today = +(d.daily_pnl || 0);          // 真实当日盈亏（账户级：当前资产 − 开盘基准资产）
      const todayPct = +(d.daily_pnl_pct || 0);
      // 累计盈亏 = 持仓市值 − 持仓成本
      let cost = 0;
      for (const p of positions) cost += (+(p.cost || 0)) * (+(p.shares || 0));
      const total = mv - cost;

      const setv = (id, v, cls) => {
        const el = document.getElementById(id); if (!el) return;
        el.textContent = v;
        el.classList.remove("up", "down"); if (cls) el.classList.add(cls);
      };
      const signed = (n, p = 0) => (n >= 0 ? "+" : "") + fmt(n, p);
      setv("akAsset",  fmt(asset, 0));
      setv("akPosition", fmt(mv, 0));
      setv("akCash",   fmt(cash, 0));
      setv("akToday",  signed(today, 0), today > 0 ? "up" : today < 0 ? "down" : "");
      document.getElementById("akAssetSub").textContent = `现金占 ${(cash / Math.max(asset, 1) * 100).toFixed(0)}%`;
      document.getElementById("akPositionSub").textContent = `${positions.length} 只持仓`;
      document.getElementById("akTodaySub").textContent = signed(todayPct, 2) + "% (vs 开盘基准)";

      // 兼容顶部折叠账户中心
      setv("kpiAsset", fmt(asset, 0));
      setv("kpiCash",  fmt(cash, 0));
      setv("kpiToday", signed(today, 0), today > 0 ? "up" : today < 0 ? "down" : "");
      setv("kpiTotal", signed(total, 0), total > 0 ? "up" : total < 0 ? "down" : "");

      // 当日交易录入：代码下拉回填当前持仓（datalist 自动补全，也允许键入新代码）
      const dl = document.getElementById("heldCodes");
      if (dl) dl.innerHTML = positions.map(p =>
        `<option value="${p.code}">${p.name || p.code}</option>`).join("");

      renderPosTable(positions);
      renderAiAdvice(positions);
      renderHoldingsBoard(positions);  // 右侧持仓看板（r17：行情看板→持仓看板）
      // 顶部 v3.1 风格 KPI 5 卡（总资产/当日涨跌/持仓/浮盈/信号）
      const set5 = (id, v, cls) => { const e = document.getElementById(id); if (e) { e.textContent = v; e.classList.remove("up", "down"); if (cls) e.classList.add(cls); } };
      try { set5("k5Asset", fmt(asset, 0)); } catch (e) { console.error("[wb] k5Asset 渲染失败", e); }
      try { set5("k5Cash", fmt(cash, 0)); } catch (e) { console.error("[wb] k5Cash 渲染失败", e); }
      try { set5("k5Chg", signed(todayPct, 2) + "%", todayPct > 0 ? "up" : todayPct < 0 ? "down" : ""); } catch (e) { console.error("[wb] k5Chg 渲染失败", e); }
      try { set5("k5Pos", positions.length + " 只"); } catch (e) { console.error("[wb] k5Pos 渲染失败", e); }
      try {
        const sigN = (state.candidates && state.candidates.length) ? state.candidates.length
                    : ((state.watchlist && state.watchlist.length) ? state.watchlist.length
                    : (window.__scanCount || 0));
        set5("k5Signal", sigN + " 个");
      } catch (e) { console.error("[wb] k5Signal 渲染失败", e); }
      // 友好占位：清掉历史遗留的 "趋势为55家" / "0家上涨" 占位文本
      try {
        const sub = (id, txt) => { const e = document.getElementById(id); if (e) e.textContent = txt; };
        sub("k5AssetSub", "现金占 " + ((cash / Math.max(asset, 1)) * 100).toFixed(0) + "%");
        sub("k5CashSub", "现金 " + fmt(cash, 0));
        sub("k5ChgSub", signed(todayPct, 2) + "% vs 开盘");
      } catch (e) {}
      computeSignalsForWatchlist();   // 自选股也注入当日行业资金流
      // 同时刷新今日已成交明细（不让"刚录入的记录"看起来消失）
      loadTradeLog();
      // 调试：把首次大开销暴露给用户，提示自动被后续覆盖
      if (took > 3000 && !state._slowNoticeShown) {
        state._slowNoticeShown = true;
        toast("首次加载 " + took + "ms（板块+指标冷启），后续 5s 缓存秒回", true);
      }
    } catch (e) {
      // 关键：渲染抛错时给用户看到具体异常 + 重试按钮，避免"持仓没了"误判
      console.error("[renderAccount] error:", e);
      showAccountErr((e && e.name) || "Error", (e && e.message) || String(e));
    }
  }

  // 账户区异常显示：渲染失败时直接把异常显式写在 KPI 上 + 提供重试按钮
  function showAccountErr(ename, emsg) {
    try {
      const tip = "⚠️ 加载异常 [" + ename + "]: " + emsg + "　<a href=\"javascript:renderAccount()\" style=\"color:#1971c2\">🔄 重试</a>　<a href=\"javascript:location.reload(true)\" style=\"color:#c92a2a\">强制刷新</a>";
      const setv = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
      setv("akAsset", "异常");
      setv("akPosition", "—");
      setv("akCash", "—");
      setv("akToday", "—");
      const sub = document.getElementById("akAssetSub");
      if (sub) sub.innerHTML = tip;
      const body = document.getElementById("posTableBody");
      if (body) body.innerHTML = '<tr><td colspan="8" class="muted-cell">加载异常，详见上方提示</td></tr>';
      const aiBody = document.getElementById("aiAdviceBody");
      if (aiBody) aiBody.innerHTML = '<div class="ai-empty">账户加载异常，请点 🔄 重试或 ⇧⌘R 强制刷新</div>';
    } catch (_) {}
  }

  // 加载今日已成交明细（刷新生效不丢）
  async function loadTradeLog() {
    try {
      const data = await api("GET", "/api/trade_log");
      if (!data || !data.ok) return;
      const body = document.getElementById("tradeLogBody");
      const summary = document.getElementById("tlSummary");
      if (summary) {
        summary.innerHTML =
          `共 <b>${(data.rows || []).length}</b> 笔 · ` +
          `<span class="up">买入支出 ¥${fmt(data.buy_amt, 0)}</span> · ` +
          `<span class="down">卖出回款 ¥${fmt(data.sell_amt, 0)}</span> · ` +
          `<b>净额 ${signed(data.net, 0)}</b>`;
      }
      if (!body) return;
      if (!data.rows || !data.rows.length) {
        body.innerHTML = '<tr><td colspan="7" class="muted-cell">暂无成交记录</td></tr>';
        return;
      }
      body.innerHTML = data.rows.map(r => {
        const sideTxt = r.side === "buy"
          ? '<span class="up"><b>买入</b></span>'
          : '<span class="down"><b>卖出</b></span>';
        return '<tr>' +
          '<td>' + (r.ts || '').slice(11, 19) + '</td>' +
          '<td>' + (r.name || r.code) + ' <span class="code-mini">' + r.code + '</span></td>' +
          '<td>' + sideTxt + '</td>' +
          '<td class="r">' + r.qty + '</td>' +
          '<td class="r">' + fmt(r.price, 2) + '</td>' +
          '<td class="r">' + (r.amount >= 0 ? '+' : '') + fmt(r.amount, 0) + '</td>' +
          '<td class="r">' + (r.cash_after != null ? fmt(r.cash_after, 0) : '--') + '</td>' +
        '</tr>';
      }).join('');
    } catch (e) { /* ignore */ }
  }

  // 持仓表：行底色按盈亏（赚钱浅红 / 亏钱浅绿 / 持平白），效果显眼且不刺眼
  function renderPosTable(positions) {
    const tb = document.getElementById("posTableBody");
    if (!tb) return;
    if (!positions || !positions.length) {
      tb.innerHTML = `<tr><td colspan="8" class="muted-cell">暂无持仓。录入一行，或在右上⚙ 设置通达信 vipdoc 路径后自动读取。</td></tr>`;
      return;
    }
    tb.innerHTML = positions.map(p => {
      const price = +(p.price || 0);
      const cost = +(p.cost || 0);
      const qty = +(p.shares || 0);
      const mkt = price * qty;
      const profit = (price - cost) * qty;
      const pct = cost > 0 ? ((price - cost) / cost * 100) : 0;
      const rowCls = profit > 0 ? "pos-row-up" : profit < 0 ? "pos-row-down" : "pos-row-flat";
      const txtCls = profit > 0 ? "up" : profit < 0 ? "down" : "";
      const it = p.industry_today || {};
      const tpct = it.trend_pct;
      const fn = it.fund_net;
      return `<tr class="${rowCls}">
        <td><b>${p.name || p.code}</b><span class="code-mini"> ${p.code}</span></td>
        <td class="r">${fmt(cost, 2)}</td>
        <td class="r">${qty}</td>
        <td class="r ${p.change_pct > 0 ? "up" : p.change_pct < 0 ? "down" : ""}">${fmt(price, 2)}<br><span class="chg-mini ${p.change_pct > 0 ? "up" : p.change_pct < 0 ? "down" : ""}">${p.change_pct != null ? (p.change_pct >= 0 ? "+" : "") + p.change_pct.toFixed(2) + "%" : "--"}</span></td>
        <td class="r">${fmt(mkt, 0)}</td>
        <td class="r ${txtCls}"><b>${signed(profit.toFixed(0))}</b></td>
        <td class="r ${txtCls}"><b>${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%</b></td>
        <td class="r pos-ind"><div class="pi-track">${it.track || it.sector || '—'}</div><div class="pi-pct ${tpct != null && tpct > 0 ? "up" : tpct != null && tpct < 0 ? "down" : ""}">${tpct != null ? (tpct >= 0 ? "+" : "") + tpct.toFixed(2) + "%" : "--"}</div><div class="pi-fund ${fn != null && fn >= 0 ? "up" : fn != null && fn < 0 ? "down" : "muted"}">${fn != null ? (fn >= 0 ? "净流入 +" : "净流出 ") + Math.abs(fn).toFixed(2) + '亿' : ""}</div></td>
      </tr>`;
    }).join("");
  }

  // -------------------------------------------
  // 做T方案生成函数（按 forecast.trend 三态）
  //   偏多 → 等回踩买入，吃今日增长利润
  //   震荡 → 高抛低吸（按支撑/压力位）
  //   偏空 → 先卖再接回做T（保住利润 + 等待再吸）
  // -------------------------------------------
  function _tpPlan(p, fcTrendRaw) {
    const price = +p.price || 0;
    const tech = p.technical || {};
    const support = +tech.support || 0;
    const resist  = +tech.resist || 0;
    const ma5 = +tech.ma5 || 0;
    const ma20 = +tech.ma20 || 0;
    const op = +p.op_price || 0;
    const fcPct = +((p.forecast || {}).pct || 0);
    const fcTrend = String(fcTrendRaw || "").replace("偏", "").trim();
    const shares = +p.shares || 0;

    // A. 偏多 → 等回踩买入，吃今日增长利润
    if (fcTrend === '多') {
      const pullback = ma5 && price > ma5 && Math.abs(price - ma5) > price * 0.002 ? ma5 :
                       (support || (ma20 || price * 0.985));
      const buyAt = +(op && op > 0 ? op : pullback).toFixed(2);
      const tgtByPct = price * (1 + Math.max(1.0, Math.abs(fcPct)) * 0.6 / 100);
      const targetAt = +(resist > 0 ? Math.min(resist * 0.995, tgtByPct) : tgtByPct).toFixed(2);
      const stop = +(support > 0 ? support * 0.98 : price * 0.96).toFixed(2);
      const addQty = +(p.op_qty || 100);
      let when;
      if (ma5 && Math.abs(price - ma5) / price < 0.003) when = '现价贴近 MA5，回踩不破就买';
      else if (ma5 && price > ma5) when = '回踩 MA5 至 ' + fmt(ma5, 2) + ' 附近不破就买';
      else if (ma20 && price > ma20) when = '回踩 MA20 至 ' + fmt(ma20, 2) + ' 企稳承接';
      else if (support) when = '回踩支撑 ' + fmt(support, 2) + ' 企稳就买';
      else when = '开盘前 30 分钟站稳现价之上即可买';
      return {
        kind: 'buy',
        lines: [
          { tag: '买', cls: 'buy', price: buyAt, qty: addQty, hint: when },
          { tag: '目标', cls: 'tp', price: targetAt, qty: null, hint: '盈利止盈' },
          { tag: '止损', cls: 'sl', price: stop, qty: null, hint: '跌破出局' }
        ],
        basis: '偏多行情，等回踩买，吃今日增长空间（预估 ' + (fcPct >= 0 ? '+' : '') + fcPct.toFixed(2) + '%）'
      };
    }

    // B. 偏空 → 先卖 → 支撑接回做 T
    if (fcTrend === '空') {
      const sellAt = +(op && op > 0 ? op : price).toFixed(2);
      const reBuyAt = +(support > 0 ? support : (ma20 || price * 0.95)).toFixed(2);
      const reBuyQ = shares ? Math.max(100, Math.floor(shares * 0.7 / 100) * 100) : 100;
      const stop = +(reBuyAt * 0.96).toFixed(2);
      const sellQty = p.op_qty || (shares ? Math.max(100, Math.floor(shares / 3 / 100) * 100) : 100);
      return {
        kind: 'sell',
        lines: [
          { tag: '先卖', cls: 'sell', price: sellAt, qty: sellQty, hint: '现价上方优先减 1/3' },
          { tag: '接回', cls: 'buy', price: reBuyAt, qty: reBuyQ, hint: '回调支撑 ' + fmt(reBuyAt, 2) + ' 吸回做 T' },
          { tag: '再止损', cls: 'sl', price: stop, qty: null, hint: '接回后再跌 4% 必止损' }
        ],
        basis: '偏空行情，先卖保利润，支撑位接回做 T（盈利空间 ' + Math.abs(fcPct).toFixed(2) + '%）'
      };
    }

    // C. 震荡 → 高抛 / 低吸
    const upper = +(resist > 0 ? resist : price * 1.025).toFixed(2);
    const lower = +(support > 0 ? support : price * 0.975).toFixed(2);
    return {
      kind: 'hold',
      lines: [
        { tag: '高抛', cls: 'sell', price: upper, qty: 100, hint: '靠近上沿 ' + fmt(upper, 2) + ' 减 1/3' },
        { tag: '低吸', cls: 'buy', price: lower, qty: 100, hint: '下沿 ' + fmt(lower, 2) + ' 买回做 T' }
      ],
      basis: '震荡区间 ' + fmt(lower, 2) + '~' + fmt(upper, 2) + '，T 赚波动利润'
    };
  }

  // 实时建议（紧凑 3 行：动作·数量 · 买卖价 · 止损止盈）
  // r16 改：去掉"回踩MA5附近不破就买"这种术语，只给数字 + 距离提示
  function _tpHtmlCompact(p, action, score) {
    const tight = p.tight || {};
    const price = p.price;
    const buy = tight.buy, sell = tight.sell;
    const sl = tight.stop_loss, tp = tight.take_profit;
    const op = p.op_price;
    const qty = p.op_qty || 0;
    const shares = p.shares || 0;

    if (!price) return '<span class="tp-mute">等价位</span>';

    // 动作标签
    let actTxt = "持有";
    let actCls = "tp-hold";
    if (action === "买入" || action === "强烈买入") { actTxt = "🟢 加仓"; actCls = "tp-buy"; }
    else if (action === "卖出") { actTxt = "🔴 减仓"; actCls = "tp-sell"; }
    else { actTxt = "🟡 持有"; actCls = "tp-hold"; }

    // 距离提示（让王总一眼看到当前价距买/卖点差多远）
    const distToBuy = buy ? ((buy - price) / price * 100) : null;
    const distToSell = sell ? ((sell - price) / price * 100) : null;
    const buyDistTxt = distToBuy != null ? ((distToBuy > 0 ? '距现价 -' : '已突破 ') + Math.abs(distToBuy).toFixed(2) + '%') : '';
    const sellDistTxt = distToSell != null ? ((distToSell > 0 ? '距现价 +' : '已突破 ') + Math.abs(distToSell).toFixed(2) + '%') : '';

    // 数量策略
    let qtyTxt = '';
    if (action === "买入" || action === "强烈买入") {
      qtyTxt = qty ? '加 <b>' + qty + '</b> 股' : '等回调';
    } else if (action === "卖出") {
      qtyTxt = qty ? '减 <b>' + qty + '</b> 股' : '减 1/3';
    } else {
      qtyTxt = shares ? '持 <b>' + shares + '</b> 股' : '—';
    }
    const opHint = op ? ('<span class="tp-op">建/平仓价 <b>' + fmt(op, 2) + '</b></span>') : '';

    return '<div class="tp-compact">' +
      '<div class="tp-l1">' +
        '<span class="tp-act ' + actCls + '">' + actTxt + '</span>　' +
        '<span class="tp-qty">' + qtyTxt + '</span>' +
        (opHint ? '　' + opHint : '') +
      '</div>' +
      '<div class="tp-l2">' +
        '<span class="tp-buy-tag">买</span>' +
        '<span class="tp-buy-px">' + (buy ? fmt(buy, 2) : '—') + '</span>' +
        (buyDistTxt ? '<span class="tp-buy-dist">' + buyDistTxt + '</span>' : '') +
        '　<span class="tp-sell-tag">卖</span>' +
        '<span class="tp-sell-px">' + (sell ? fmt(sell, 2) : '—') + '</span>' +
        (sellDistTxt ? '<span class="tp-sell-dist">' + sellDistTxt + '</span>' : '') +
      '</div>' +
      '<div class="tp-l3">' +
        '<span class="tp-sl-tag">止损</span><span class="tp-sl-px">' + (sl ? fmt(sl, 2) : '—') + '</span>' +
        '　<span class="tp-tp-tag">止盈</span><span class="tp-tp-px">' + (tp ? fmt(tp, 2) : '—') + '</span>' +
      '</div>' +
    '</div>';
  }

  // 技术细节行：KDJ + MACD + 量能 + RSI + BOLL
  // r16：王总原话"持仓只看 MACD 和 KDJ 还有量能这些，我需要最及时的技术面"
  function _aiTechDetailHtml(p) {
    const ts = p.tech_short || {};
    const tm = ((p.intraday || {}).metrics) || {};
    const kj = ts.kdj_j != null ? ts.kdj_j : tm.kdj_j;
    const ks = ts.kdj_status || tm.kdj_status;
    const kt = ts.kdj_turn || tm.kdj_turn;
    const mr = ts.macd_status || tm.macd_status;
    const vr = ts.vol_ratio != null ? ts.vol_ratio : (tm.vol_ratio != null ? tm.vol_ratio : null);
    const rsi = ts.rsi != null ? ts.rsi : (tm.rsi != null ? tm.rsi : null);
    const bp = ts.boll_pos || tm.boll_pos;

    const kdjJCls = kj != null ? (kj > 90 ? 'kdj-hot' : kj < 10 ? 'kdj-cold' : 'kdj-mid') : 'kdj-mid';
    const kdjStatusCls = ks === '超买' ? 'kdj-hot' : ks === '超卖' ? 'kdj-cold' : 'kdj-mid';
    const kdjTurnCls = kt === '上拐' ? 'kdj-up' : kt === '下拐' ? 'kdj-down' : 'kdj-mid';
    const macdCls = mr === '红柱扩' ? 'macd-bull' : mr === '红柱缩' ? 'macd-bear' : mr === '绿柱' ? 'macd-bear' : 'macd-flat';
    const vrCls = vr != null ? (vr >= 1.5 ? 'vol-up' : vr <= 0.6 ? 'vol-dn' : 'vol-mid') : '';
    const rsiCls = rsi != null ? (rsi >= 70 ? 'kdj-hot' : rsi <= 30 ? 'kdj-cold' : 'kdj-mid') : '';

    return '<div class="ai-tech-detail">' +
      '<span class="td-tag">📡 KDJ+MACD+量能（持仓短线）</span>' +
      '<span class="td-seg"><b>KDJ</b>' +
        '<span class="' + kdjJCls + '">J=' + (kj != null ? kj.toFixed(0) : '—') + '</span>' +
        '<span class="' + kdjStatusCls + '">' + (ks || '—') + '</span>' +
        '<span class="' + kdjTurnCls + '">' + (kt || '—') + '</span>' +
      '</span>' +
      '<span class="td-sep">｜</span>' +
      '<span class="td-seg"><b>MACD</b>' +
        '<span class="' + macdCls + '">' + (mr || '—') + '</span>' +
      '</span>' +
      (vr != null ? (
        '<span class="td-sep">｜</span>' +
        '<span class="td-seg"><b>量能</b>' +
          '<span class="' + vrCls + '">量比 ' + vr.toFixed(2) + '</span>' +
        '</span>'
      ) : '') +
      (rsi != null ? (
        '<span class="td-sep">｜</span>' +
        '<span class="td-seg"><b>RSI</b>' +
          '<span class="' + rsiCls + '">' + rsi.toFixed(0) + '</span>' +
        '</span>'
      ) : '') +
      (bp ? (
        '<span class="td-sep">｜</span>' +
        '<span class="td-seg"><b>BOLL</b>' +
          '<span>' + bp + '</span>' +
        '</span>'
      ) : '') +
    '</div>';
  }

  function _tpHtml(plan) {
    if (!plan || !plan.lines || !plan.lines.length) {
      return '<div class="tp-line"><span class="tp-tag hold">持有</span><span class="tp-when">等价格到位</span></div>';
    }
    const head = plan.lines.map(l => {
      const cls = l.cls === 'buy' ? 'buy' : l.cls === 'sell' ? 'sell' : l.cls === 'tp' ? 'tp' : 'sl';
      const priceTag = l.price != null ? '<span class="tp-price ' + cls + '">' + fmt(l.price, 2) + '</span>' : '';
      const qty = l.qty ? '<span class="tp-qty">×' + l.qty + '</span>' : '';
      return '<div class="tp-line"><span class="tp-tag ' + cls + '">' + l.tag + '</span>' + priceTag + qty + '<span class="tp-when">' + (l.hint || '') + '</span></div>';
    }).join('');
    return head + (plan.basis ? '<div class="tp-basis">' + plan.basis + '</div>' : '');
  }

  // 操作建议（紧凑三档：买/卖/止损&止盈）—— 拒绝"回踩 MA5 附近不破就买"这种术语，只给数字
  // 数据源：p.tight（后端 _tight_levels 计算：现价×0.992/1.008/0.97/1.03）
  function _opHtml(p) {
    const tight = p.tight || {};
    const price = p.price;
    const buy = tight.buy;
    const sell = tight.sell;
    const sl = tight.stop_loss;
    const tp = tight.take_profit;
    const band = tight.band || "现价 ±0.8%";
    const act = (p.action || "").toLowerCase();
    if (!price || (!buy && !sell && !sl && !tp)) {
      // 数据不足时回退做T方案
      const plan = _tpPlan(p, "");
      return _tpHtml(plan);
    }
    const pct = (v) => v == null ? "—" : ((v - price) / price * 100).toFixed(1) + "%";
    const clsBuy = act.includes("买") || act.includes("加仓") ? "op-on" : "";
    const clsSell = act.includes("卖") || act.includes("减仓") || act.includes("止盈") ? "op-on" : "";
    return '<div class="op-grid">' +
        // 显眼大字「买」
        '<div class="op-row op-big ' + clsBuy + '">' +
          '<span class="op-tag buy">买</span>' +
          '<span class="op-price op-price-buy">' + fmt(buy, 2) + '</span>' +
          '<span class="op-pct op-pct-dn">' + (tight.buy_pct != null ? (tight.buy_pct >= 0 ? '+' : '') + tight.buy_pct.toFixed(1) + "%" : pct(buy)) + '</span>' +
        '</div>' +
        // 显眼大字「卖」
        '<div class="op-row op-big ' + clsSell + '">' +
          '<span class="op-tag sell">卖</span>' +
          '<span class="op-price op-price-sell">' + fmt(sell, 2) + '</span>' +
          '<span class="op-pct op-pct-up">' + (tight.sell_pct != null ? "+" + tight.sell_pct.toFixed(1) + "%" : pct(sell)) + '</span>' +
        '</div>' +
        // 止损 + 止盈 横排
        '<div class="op-row op-row-tpsl">' +
          '<span class="op-tag stop">止损</span>' +
          '<span class="op-price">' + fmt(sl, 2) + '</span>' +
          '<span class="op-pct">' + pct(sl) + '</span>' +
          '<span class="op-tag tp">止盈</span>' +
          '<span class="op-price">' + fmt(tp, 2) + '</span>' +
          '<span class="op-pct">' + pct(tp) + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="op-band">' + band +
        (tight.support ? ' · 支撑 ' + fmt(tight.support, 2) : '') +
        (tight.resist ? ' · 阻力 ' + fmt(tight.resist, 2) : '') +
      '</div>';
  }

  // 实时动态建议（盘中 1min 分时 + 现价 + 资金）→ 闪烁标签
  // 数据源：p.intraday（后端 _intraday_for）含 scenario/action/target_price/stop_loss/basis
  function _liveHint(p) {
    const it = p.intraday || {};
    const scene = it.scenario || "";
    const act = it.action || "";
    if (!act && !scene) return '<span class="ai-live idle" title="无实时数据">⚡—</span>';
    let hint = "", cls = "wait";
    if (act.includes("买") || act.includes("加仓") || act.includes("低吸")) {
      hint = "⚡实时：建议立即买入"; cls = "buy";
    } else if (act.includes("卖") || act.includes("止盈") || act.includes("减仓")) {
      hint = "⚡实时：建议立即卖出"; cls = "sell";
    } else if (scene && scene.includes("突破")) {
      hint = "⚡实时：放量突破"; cls = "buy";
    } else if (scene && (scene.includes("弱势") || scene.includes("风险"))) {
      hint = "⚡实时：弱势震荡"; cls = "warn";
    } else if (act.includes("持有") || scene.includes("持有") || scene.includes("震荡")) {
      hint = "⚡实时：观望持有"; cls = "wait";
    } else {
      hint = "⚡实时：" + (scene || act || "—"); cls = "wait";
    }
    return '<span class="ai-live ' + cls + '" title="' + (it.basis || scene || "") + '">' + hint + '</span>';
  }

  // -------------------------------------------
  // AI 建议列表（每只持仓一行，七列；用 <table> 严格列对齐）
  // -------------------------------------------
function renderAiAdvice(positions) {
    const el = document.getElementById("aiAdviceBody");
    if (!el) return;
    if (!positions || !positions.length) {
      el.innerHTML = '<div class="ai-empty">暂无持仓，添加一行后这里会出现加减仓建议。</div>';
      return;
    }
    // 按评分绝对值降序：最强信号（最值得操作）在最上面
    const sorted = positions.slice().sort((a, b) => Math.abs(+(b.advice_score || 0)) - Math.abs(+(a.advice_score || 0)));
    // r16: 4 列极简横向：股票 / 评分 / 今日预估+板块 / 实时建议
    // 仿参考截图1的简洁感，4 列严格对齐。MA5/MA20 不再用于持仓，只用 KDJ+MACD+量能
    el.innerHTML = '<table class="ai-table">' +
      '<thead><tr>' +
        '<th class="ai-c-name" style="min-width:140px">股票</th>' +
        '<th class="ai-c-score" style="width:74px">评分</th>' +
        '<th class="ai-c-fc" style="min-width:270px">今日预估 + 板块</th>' +
        '<th class="ai-c-tp" style="min-width:300px">实时建议</th>' +
      '</tr></thead>' +
      '<tbody>' + sorted.map(_aiCardHtml).join("") + '</tbody>' +
      '</table>';
  }

  // AI 卡片：横向表格一行（5 列：股票 / 评分 / 操作 / 今日预估+板块 / 偏T方案）
  // 核心：跟实盘走 + 利润最大化 —— 偏T方案的 buy/sell 给 ATR 宽度，不做"±0.8% 紧价"。
  function _aiCardHtml(p) {
    // r16: 持仓只参考 KDJ+MACD+量能（最及时技术面），MA5/MA20 给自选筛股
    // 4 列极简横向：股票 / 评分 / 今日预估+板块 / 实时建议
    const action = p.action || "不动";
    const score = p.advice_score != null ? p.advice_score : 0;
    const cls = action === "买入" || action === "强烈买入" ? "ai-buy" : action === "卖出" ? "ai-sell" : "ai-hold";
    // r16: 整行白底，靠左侧 4px 色条 + 行内评级圆点传达信号，不刺眼
    const rowCls = "ai-row-flat";

    // 评级圆点 + 文字（合并到"股票"列里，整张表 4 列）
    const gradeTxt = action === "买入" || action === "强烈买入" ? "加仓" :
                     action === "卖出" ? "减仓" : "持有";

    // 价格 + 涨跌%
    const pxTxt = p.price != null ? fmt(p.price, 2) : '--';
    const change = p.change_pct != null ? p.change_pct : null;
    const changeCls = change == null ? '' : (change >= 0 ? 'up' : 'down');
    const changeTxt = change == null ? '' : (change >= 0 ? '+' : '') + change.toFixed(2) + '%';

    // 今日预估
    const fc = p.forecast || {};
    const fcTrend = fc.trend || "震荡";
    const fcCls = fcTrend === "偏多" ? "up" : fcTrend === "偏空" ? "down" : "flat";
    const fcPct = fc.pct != null ? fc.pct : 0;
    const fcHi = fc.forecast_high;
    const fcLo = fc.forecast_low;
    // r16: 资金净流入已在板块块承载，去重；再过滤 MA 系列（中线指标不用于持仓）
    const basisHtml = (fc.basis || [])
      .filter(b => b && !/资金净流入|净流入|均线|MA\d+/.test(b))
      .slice(0, 5)
      .map(b => '<li>' + b + '</li>').join("");

    // 板块（合并到今日预估下方）
    const sec = p.sector_detail || p.industry_today || {};
    const secName = sec.name || sec.track || sec.sector || '—';
    const secTrend = sec.trend_pct != null ? sec.trend_pct : null;
    const secFund = sec.fund_net != null ? sec.fund_net : null;
    const secProxy = sec.fund_proxy ? '<span class="sec-est">估</span>' : '';
    const secPctCls = secTrend == null ? '' : (secTrend >= 0 ? 'sec-up' : 'sec-dn');
    const secPctTxt = secTrend == null ? '—' : (secTrend >= 0 ? '+' : '') + secTrend.toFixed(2) + '%';
    const secFundCls = secFund == null ? '' : (secFund >= 0 ? 'sec-fund-in' : 'sec-fund-out');
    const secFundTxt = secFund == null ? '' : ('<span class="sec-fund-val ' + secFundCls + '">' + (secFund >= 0 ? '流入+' : '流出') + Math.abs(secFund).toFixed(1) + '亿' + secProxy + '</span>');
    const upRatioTxt = sec.up_ratio != null ? '<span class="sec-fund-mini">上涨占比 <b>' + (sec.up_ratio * 100).toFixed(0) + '%</b></span>' : '';

    // r16: 实时建议（紧凑 5 行：动作·数量·买卖价·止损·止盈）+ 技术细节行（KDJ+MACD+量能）
    const tpHtml = _tpHtmlCompact(p, action, score);
    const detailHtml = _aiTechDetailHtml(p);

    // rowCls 直接白底（不用 ai-strong）
    return '<tr class="' + rowCls + '">' +
      // ① 股票（合并"评级+股票名+代码+当前价+涨跌"）
      '<td class="ai-c-name">' +
        '<div class="ai-grade-row">' +
          '<span class="ai-grade-dot ' + cls + '">●</span>' +
          '<span class="ai-grade-text ' + cls + '">' + gradeTxt + '</span>' +
          '<span class="ai-name-main"><b>' + (p.name || p.code) + '</b></span>' +
          '<i class="ai-code-mini">' + p.code + '</i>' +
        '</div>' +
        '<div class="ai-price-row">' +
          '<span class="ai-px"><b>' + pxTxt + '</b></span>' +
          (changeTxt ? '<span class="ai-px-chg ' + changeCls + '">' + changeTxt + '</span>' : '') +
        '</div>' +
      '</td>' +
      // ② 评分
      '<td class="ai-c-score ' + cls + '">' +
        '<div class="ai-score-num ' + cls + '">' + (score > 0 ? '+' : '') + score + '</div>' +
        '<div class="ai-score-cap">分</div>' +
      '</td>' +
      // ③ 今日预估 + 板块（r16: 去掉 MA 系列 basis；板块块沿用）
      '<td class="ai-c-fc">' +
        '<div class="fc-head">' +
          '<span class="fc-trend ' + fcCls + '">' + fcTrend + '</span>' +
          '<span class="fc-pct ' + fcCls + '">' + (fcPct >= 0 ? '+' : '') + fcPct.toFixed(2) + '%</span>' +
          ((fcHi || fcLo) ? '<span class="fc-band-mini">高 <b>' + (fcHi ? fmt(fcHi, 2) : '—') + '</b> / 低 <b>' + (fcLo ? fmt(fcLo, 2) : '—') + '</b></span>' : '') +
        '</div>' +
        (basisHtml ? '<ul class="fc-basis">' + basisHtml + '</ul>' : '') +
        // 板块块（r16: 单行紧凑版，含名称/涨跌幅/资金流入/上涨占比）
        '<div class="ai-sec-block">' +
          '<span class="sec-name">' + secName + '</span>' +
          '<span class="sec-pct ' + secPctCls + '">' + secPctTxt + '</span>' +
          (secFundTxt ? '　' + secFundTxt : '') +
          (upRatioTxt ? '　' + upRatioTxt : '') +
        '</div>' +
      '</td>' +
      // ④ 实时建议（r16: 紧凑 5 行，仿真参考截图 1）
      '<td class="ai-c-tp">' + tpHtml + '</td>' +
    '</tr>' +
    // ⑤ 技术细节行（KDJ+MACD+量能 —— 王总原话"持仓只看这些"）
    '<tr class="ai-detail-row">' +
      '<td colspan="4" class="ai-detail-cell">' + detailHtml + '</td>' +
    '</tr>';
  }

  // 给自选股注入今日赛道（板块资金流走的是同个数据源，后端 positions_advice 已含，自选侧复用同 cache）
  function computeSignalsForWatchlist() {
    // 直接复用现有自选刷新逻辑；为简单就不再加重，watchMeta 里有 change_pct 即可
    if (state.watchlist && state.watchlist.length) computeSignals();
  }

  function fmt(n, d = 2) { return n == null ? "--" : Number(n).toFixed(d); }
  function round2(n) { return n == null ? null : Math.round(Number(n) * 100) / 100; }
  function chgClass(v) { return v > 0 ? "up" : v < 0 ? "down" : ""; }
  function signed(n, p = 0) { return (n >= 0 ? "+" : "") + fmt(n, p); }

  // ---------- 初始化 ----------
  async function init() {
    // 图表已被移除（用户不要了），旧函数对 chart 的引用会安全跳过
    let cfg = {};
    try { cfg = (await api("GET", "/api/config")) || {}; }
    catch (e) {
      console.warn("配置加载失败，使用离线默认值：", e);
      toast("未能连接后端，已用离线默认值（部分功能可能受限）");
    }
    try {
      $("#tdxStatus").textContent = cfg.tdx_available
        ? "数据源：通达信本地 + 在线" : "数据源：在线行情（未配置通达信）";
      $("#marketBadge").textContent = cfg.market || "A股";
    } catch (e) {}
    // 注意：已按需求移除「可用资金」输入（扫描候选量改由后端默认配置计算）

    bindEvents();
    try { bindReviewButtons(); } catch (e) { console.warn('[wb] bindReviewButtons:', e && e.message); }
    try { bindKline(); } catch (e) { console.warn('[wb] bindKline:', e && e.message); }
    try { bindTopbar(); } catch (e) { console.warn('[wb] bindTopbar:', e && e.message); }
    // 任何一步失败都不影响其余渲染（避免整页白屏）
    // 首屏提速：自选 + 持仓 并发拉取
    try { await Promise.all([loadWatchlist(), loadPositions()]); } catch (e) { console.warn("自选/持仓并发加载失败：", e); }
    // 让真实持仓立即出现在行情看板左侧（无需等自动优选扫描）
    try { if ((!state.view || state.view === "dashboard") && typeof renderSelfStocks === "function") renderSelfStocks(); } catch (e) {}
    try { setupWeights(cfg); } catch (e) {}
    try {
      $("#apiBase").value = API_BASE;
      $("#tdxPath").value = cfg.tdx_path || "";
      $("#tdxPathTip").textContent = cfg.tdx_available
        ? "已启用本地数据：" + cfg.tdx_path
        : "填好后，选股下拉选「通达信全市场」即可扫描全部 A 股日线（需先在通达信下载日线数据）。";
    } catch (e) {}
    startClock();
    // 账户 + 持仓 + AI 建议：首次后台加载（不等它完成，立即让页面其它东西先出来）
    renderAccount().catch(e => console.warn("账户刷新失败：", e));
    // 之后每 5 秒刷新一次（更紧的实时节奏，配合盘中实时建议闪烁）
    state.timers.push(setInterval(renderAccount, 5000));
    // 尾盘策略：30 秒刷新（r27 已删，保留空壳兼容旧调用）
    try { loadTailStrategy(); } catch (e) {}
    state.timers.push(setInterval(loadTailStrategy, 30000));
    // 每日策略已删除（用户反馈不需要）：pollDailyStrategy/renderDaily/renderDailySnap/_dsColor 函数定义保留作废代码，init() 不再触发
    // r27：旧 loadReview（每日复盘）已删，保留空函数避免旧引用报错；新版复盘在 review 视图按需拉取
    try { loadReview(); } catch (e) {}
    // r27：信号扫描页首次进入时预热尾盘买入法候选池
    try {
      api('GET', '/api/tail_buy').then(d => {
        if (d && d.ok) {
          const statEls = document.querySelectorAll('[id^="tailbuyStatus"]');
          statEls.forEach(el => el.textContent = d.generated_at ? '更新于 ' + d.generated_at : '已生成');
        }
      }).catch(() => {});
    } catch (e) {}
    // 自动优选：8 秒后异步触发（延后避免抢首屏带宽；r37：扫描间隔由 10 分钟 → 90 秒）
    setTimeout(() => {
      autoScan().catch(e => console.warn("自动优选启动失败：", e));
    }, 8000);
    state.timers.push(setInterval(autoScan, 90 * 1000));
  }

  function startClock() {
    const tick = () => { $("#clock").textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false }); };
    tick(); setInterval(tick, 1000);
  }

  function bindEvents() {
    // 搜索
    let st;
    $("#searchInput").addEventListener("input", (e) => {
      clearTimeout(st);
      const q = e.target.value.trim();
      if (!q) { $("#searchResults").innerHTML = ""; return; }
      st = setTimeout(async () => {
        const list = await api("GET", "/api/search?q=" + encodeURIComponent(q));
        $("#searchResults").innerHTML = list.map(it =>
          `<div class="search-item" data-code="${it.code}" data-name="${it.name}">
             <span>${it.name}</span><span class="code">${it.code}</span></div>`).join("");
        $("#searchResults").querySelectorAll(".search-item").forEach(el =>
          el.addEventListener("click", () => {
            addToWatchFromSearch(el.dataset.code, el.dataset.name);
            $("#searchInput").value = ""; $("#searchResults").innerHTML = "";
          }));
      }, 250);
    });

    // 全局搜索：点击结果直接加入自选
    const gs = $("#globalSearch");
    const gsResults = $("#globalSearchResults");
    let gsTimer;
    if (gs) gs.addEventListener("input", e => {
      clearTimeout(gsTimer);
      const q = e.target.value.trim();
      if (!q) { gsResults.classList.remove("open"); gsResults.innerHTML = ""; return; }
      gsTimer = setTimeout(async () => {
        const list = await api("GET", "/api/search?q=" + encodeURIComponent(q));
        if (!list || !list.length) { gsResults.innerHTML = '<div class="gsr-row"><span>无匹配</span></div>'; gsResults.classList.add("open"); return; }
        gsResults.innerHTML = list.slice(0, 8).map(it =>
          `<div class="gsr-row" data-code="${it.code}" data-name="${it.name}">
             <span>${it.name}</span><span class="gsr-meta">${it.code}</span></div>`).join("");
        gsResults.classList.add("open");
        gsResults.querySelectorAll(".gsr-row[data-code]").forEach(el =>
          el.addEventListener("click", () => {
            addToWatchFromSearch(el.dataset.code, el.dataset.name);
            gs.value = ""; gsResults.classList.remove("open"); gsResults.innerHTML = "";
          }));
      }, 220);
    });
    document.addEventListener("click", e => {
      if (gs && !gs.contains(e.target) && !gsResults.contains(e.target)) {
        gsResults.classList.remove("open");
      }
    });

    // 全局判案（P1）：触发每日策略的"open_judgment"并弹窗综述
    const gj = $("#globalJudge");
    if (gj) gj.addEventListener("click", async () => {
      gj.disabled = true; const old = gj.textContent; gj.textContent = "判案中…";
      try {
        const r = await api("GET", "/api/daily_strategy");
        const op = r && r.open;
        if (!op) { toast("暂无开盘判断，先把持仓同步并等 09:28 自动化跑", true); return; }
        const t = op.trend, conf = op.confidence, dt = (op.ts || "").slice(11, 16);
        const sugg = (op.suggestions || []).slice(0, 6);
        const body = sugg.map(s => `· ${s.action} ${s.name}(${s.code})${s.price?" @"+s.price:""}${s.qty?" ×"+s.qty+"股":""}`).join("\n");
        const html = `<div style="text-align:left;font-size:13px;line-height:1.7">
          <div>大势：<b style="color:${t==='看涨'?'#c92a2a':t==='看跌'?'#2b8a3e':'#888'}">${t}</b>　置信 ${conf}%　<span style="color:#999">(更新于 ${dt})</span></div>
          <div style="margin:8px 0 4px;color:#666">前 6 条建议：</div>
          <pre style="margin:0;white-space:pre-wrap;font-family:inherit">${body || "(空)"}</pre>
        </div>`;
        if (window.WorkBuddyShowModal) window.WorkBuddyShowModal(html, "⚖ 全局判案 · 今日开盘判断");
        else alert(`大势 ${t} / 置信 ${conf}%\n\n${body}`);
      } catch (e) { toast("判案失败：" + e.message, true); }
      finally { gj.disabled = false; gj.textContent = old; }
    });

    $("#addCurrent").addEventListener("click", addCurrentToWatch);
    $("#refreshSignals").addEventListener("click", () => { pollQuotes(); computeSignals(); });
    const rs = $("#refreshSelf");
    if (rs) rs.addEventListener("click", autoScan);
    // r37：板块扫描区手动刷新按钮
    const sfBtn = document.getElementById("scanFreshBtn");
    if (sfBtn) sfBtn.addEventListener("click", manualScan);
    $("#rebuildBtn").addEventListener("click", rebuildUniverse);

    // 当日交易录入（买卖驱动真实盈亏 / 成本 / 股数 / 现金）
    bindTradeEntry();
    $("#saveWeights").addEventListener("click", saveWeights);
    $("#resetWeights").addEventListener("click", resetWeights);
    $("#saveApiBase").addEventListener("click", async () => {
      const v = $("#apiBase").value.trim();
      if (!v) {
        API_BASE = "";
        localStorage.removeItem("wb_api_base");
        toast("已切回本机（同源）");
        return;
      }
      if (!/^https?:\/\//i.test(v)) {
        toast("地址需以 http:// 或 https:// 开头，未保存");
        return;
      }
      // 先测试连通性，避免存了个连不上的地址 → 整页白屏
      try {
        const test = await fetch(v.replace(/\/$/, "") + "/api/config", { method: "GET" });
        if (!test.ok) throw new Error("HTTP " + test.status);
        await test.json().catch(() => ({}));
        API_BASE = v;
        localStorage.setItem("wb_api_base", API_BASE);
        try { await api("POST", "/api/config", { cloud_url: API_BASE }); } catch (e) {}
        toast("已设云端后端：" + API_BASE);
      } catch (e) {
        toast("该地址连不上（" + e.message + "），未保存，仍用本机");
      }
    });
    $("#saveTdx").addEventListener("click", async () => {
      const p = $("#tdxPath").value.trim();
      const r = await api("POST", "/api/config", { tdx_path: p });
      $("#tdxPathTip").textContent = r.tdx_available
        ? "已启用本地数据：" + p
        : (p ? "该路径不存在或不是 vipdoc 目录，请检查（应含 sh\\lday、sz\\lday）" : "已清空，使用在线行情");
      toast(r.tdx_available ? "通达信数据已启用" : (p ? "路径未生效" : "已切换为在线行情"));
    });
  }

  // 当日交易录入：提交 → POST /api/trade → 重拉账户（现金/成本/股数/真实盈亏自动更新）
  function bindTradeEntry() {
    const btn = document.getElementById("tradeBtn");
    if (!btn) return;
    btn.addEventListener("click", async () => {
      const code = ($("#tradeCode").value || "").trim();
      const side = $("#tradeSide").value;
      const qty = parseInt($("#tradeQty").value || "0", 10);
      const price = parseFloat($("#tradePrice").value || "0");
      if (!code) { toast("请输入代码/名称"); return; }
      if (!qty || qty <= 0) { toast("请输入数量"); return; }
      if (!price || price <= 0) { toast("请输入价格"); return; }
      btn.disabled = true; const old = btn.textContent; btn.textContent = "记录中…";
      try {
        const r = await api("POST", "/api/trade", { code, side, qty, price });
        if (r && r.ok) {
          toast(`${side === "buy" ? "买入" : "卖出"} ${qty}股 @¥${price} 已记录（现金 ¥${fmt(r.cash, 0)}）`);
          $("#tradeQty").value = ""; $("#tradePrice").value = "";
          // 立即刷新明细（不让"刚记录的一笔"看起来消失）
          loadTradeLog();
          await renderAccount();
        } else {
          toast("记录失败：" + (r && r.error ? r.error : "未知错误"));
        }
      } catch (e) {
        toast("记录失败：" + e.message);
      } finally {
        btn.disabled = false; btn.textContent = old;
      }
    });
    // 数量快速加减（±100 / ±500）
    document.querySelectorAll(".qty-step").forEach(b =>
      b.addEventListener("click", () => {
        const inp = document.getElementById("tradeQty");
        const cur = parseInt(inp.value || "0", 10);
        const delta = parseInt(b.dataset.delta || "0", 10);
        let next = cur + delta;
        if (next < 0) next = 0;
        // A 股 1 手 = 100 股，不足 1 手按 1 手算
        if (next > 0 && next % 100 !== 0) next = Math.ceil(next / 100) * 100;
        inp.value = next;
        inp.focus();
      }));
  }

  function toggleOpts() {
    return {
      showBoll: $("#tgBoll")?.checked ?? true,
      showMacd: $("#tgMacd")?.checked ?? true,
      showKdj: $("#tgKdj")?.checked ?? true,
      showRsi: $("#tgRsi")?.checked ?? false,
    };
  }

  // ---------- 自选（带元数据：添加时间/添加价/推荐买价） ----------
  async function loadWatchlist() {
    // 按服务端返回为准（服务端已双写 data/ + static/ 主源，刷新/重启不丢）
    // 不再用硬编码种子覆盖用户自己加的自选
    try {
      const list = await api("GET", "/api/watchlist");
      state.watchlist = Array.isArray(list) ? list : [];
    } catch (e) {
      state.watchlist = state.watchlist || [];
    }
    renderWatchlist();
    await pollQuotes();
    await computeSignals();
  }

  async function saveWatchlist() {
    // 用 items 增量合并，保留已有元数据（添加时间/价格/推荐买价）
    return await api("POST", "/api/watchlist", { items: state.watchlist });
  }

  // 代码归一化（去空格/转小写），避免 sh600519 / SH600519 / 600519 误判重复或漏判
  function _normCode(c) { return (c || "").toString().trim().toLowerCase(); }
  function _inWatch(code) { const n = _normCode(code); return state.watchlist.some(w => _normCode(w.code) === n); }

  function renderWatchlist() {
    // 合并渲染：自选 + 自动优选 统一进「自选股票」列表
    renderSelfStocks();
  }

  // 自动优选（候选扫描）+ 自选 合并成一张按「购买优先级」排序的列表
  const SS_RANK = { '强烈买入': 0, '买入': 0, '加仓': 0, '持有': 1, '持有观察': 1, '减仓': 2, '卖出': 2 };

  function _ssActionClass(act) {
    if (act === "强烈买入" || act === "买入" || act === "加仓") return "ss-buy";
    if (act === "减仓" || act === "卖出") return "ss-sell";
    return "ss-hold";
  }

  function buildSelfList() {
    const out = [];
    // 自动优选（候选扫描结果）
    (state.candidates || []).forEach(r => {
      out.push({
        origin: "优选",
        code: r.code, name: r.name || r.code,
        action: r.action || "",
        score: r.combined != null ? r.combined : (r.score != null ? r.score : null),
        price: r.price, change_pct: r.change_pct,
        buy_price: r.buy_price, sell_price: r.sell_price,
        track: r.track, sector_trend: r.sector_trend, sector_fund: r.sector_fund,
        fund_grade: r.fund_grade, pe: r.pe,
        tech_score: r.tech_score, sector_score: r.sector_score, val_score: r.val_score, mom_score: r.mom_score,
        raw: r,
      });
    });
    // 自选（用户手动加，带实时信号）
    (state.watchlist || []).forEach(w => {
      const m = state.watchMeta[w.code] || {};
      out.push({
        origin: "自选",
        code: w.code, name: m.name || w.name || w.code,
        action: m.action || "",
        score: m.score != null ? m.score : null,
        price: m.price != null ? m.price : (w.add_price || null), change_pct: m.change_pct,
        buy_price: w.scan_buy, sell_price: null,
        track: m.track, sector_trend: m.sector_trend, sector_fund: m.sector_fund,
        fund_grade: m.fund_grade, pe: m.pe,
        tech_score: m.tech_score, sector_score: m.sector_score, val_score: m.val_score, mom_score: m.mom_score,
        watch: w,
      });
    });
    // 用户真实持仓（来自 /api/positions）：行情看板左侧也要能直接看到自己的股票，点开即看详情
    (state.positions || []).forEach(p => {
      const code = p.code || "";
      if (out.some(o => _normCode(o.code) === _normCode(code))) return; // 去重：候选/自选里已有时不重复
      const m = state.watchMeta[code] || {};
      out.push({
        origin: "持仓",
        code: code, name: p.name || m.name || code,
        action: p.action || m.action || "",
        score: p.score != null ? p.score : (m.score != null ? m.score : null),
        price: p.price != null ? p.price : (m.price != null ? m.price : null),
        change_pct: p.change_pct != null ? p.change_pct : m.change_pct,
        buy_price: p.buy_price != null ? p.buy_price : m.buy_price,
        sell_price: p.sell_price != null ? p.sell_price : m.sell_price,
        track: p.track || m.track,
        sector_trend: p.sector_trend != null ? p.sector_trend : m.sector_trend,
        sector_fund: p.sector_fund != null ? p.sector_fund : m.sector_fund,
        fund_grade: p.fund_grade || m.fund_grade,
        pe: p.pe != null ? p.pe : m.pe,
        tech_score: p.tech_score, sector_score: p.sector_score, val_score: p.val_score, mom_score: p.mom_score,
        position: p,
      });
    });
    // 排序：强买>买入>持有>减仓>卖出；同档按综合分/评分降序
    out.sort((a, b) => {
      const ra = SS_RANK[a.action] != null ? SS_RANK[a.action] : 1;
      const rb = SS_RANK[b.action] != null ? SS_RANK[b.action] : 1;
      if (ra !== rb) return ra - rb;
      const sa = a.score != null ? a.score : -1e9;
      const sb = b.score != null ? b.score : -1e9;
      return sb - sa;
    });
    return out;
  }

  // ---------- 持仓看板（r17：行情看板→持仓看板） ----------
  // 用 /api/positions_advice 的实时字段渲染持仓股卡片网格，直接驱动实时建议
  function renderHoldingsBoard(positions) {
    const el = document.getElementById("holdingsBoard");
    if (!el) return;
    if (!el) return;
    const cnt = document.getElementById("hbCount");
    if (cnt) cnt.textContent = `共 ${positions.length} 只`;
    if (!positions || !positions.length) {
      el.innerHTML = '<div class="signal-empty">暂无持仓，添加一行后这里会出现持仓看板。</div>';
      return;
    }
    // 按评分绝对值降序：信号最强的排最上
    const sorted = positions.slice().sort((a, b) => Math.abs(+(b.advice_score || 0)) - Math.abs(+(a.advice_score || 0)));
    el.innerHTML = sorted.map(hbCardHtml).join("");
  }
  // v3.1 风格技术进度条（0~100 填充 + 右侧数值）
  function _hbBar(name, pct, txt) {
    const w = Math.max(0, Math.min(100, pct));
    return `<div class="hb-bar">
      <span class="hb-bar-name">${name}</span>
      <span class="hb-bar-track"><i style="width:${w}%"></i></span>
      <span class="hb-bar-val">${txt}</span>
    </div>`;
  }
  function hbCardHtml(p) {
    const action = p.action || "不动";
    const label = p.action_label || (action === "买入" ? "加仓" : action === "卖出" ? "减仓" : "持有");
    const cls = action === "买入" || action === "强烈买入" ? "buy" :
                action === "卖出" ? "sell" : "hold";
    const color = cls === "buy" ? "#2b8a3e" : cls === "sell" ? "#c92a2a" : "#f59f00";
    const px = p.price != null ? fmt(p.price, 2) : "--";
    const chg = p.change_pct != null ? (p.change_pct >= 0 ? "+" : "") + p.change_pct.toFixed(2) + "%" : "";
    const chgCls = p.change_pct == null ? "" : (p.change_pct >= 0 ? "up" : "down");
    const ts = p.tech_short || {};
    const score = p.advice_score != null ? p.advice_score : 0;
    const scorePct = Math.max(0, Math.min(100, (score + 100) / 2));
    const scoreColor = score > 0 ? "#2b8a3e" : score < 0 ? "#c92a2a" : "#868e96";
    const shares = p.shares != null ? p.shares + "股" : "";

    // —— 技术进度条映射（v3.1 标志：KDJ / MACD / 量能 / RSI）——
    const kdjJ = ts.kdj_j != null ? +ts.kdj_j : null;
    const kdjPct = kdjJ != null ? (kdjJ + 100) / 2 : 50;
    const kdjTxt = kdjJ != null ? ("J " + kdjJ + (ts.kdj_status ? "·" + ts.kdj_status : "")) : "J —";
    const macdMap = { "红柱": 88, "红柱放": 95, "红柱缩": 72, "金叉": 88, "绿柱": 12, "绿柱放": 5, "绿柱缩": 28, "死叉": 12 };
    const macdPct = macdMap[ts.macd_status] != null ? macdMap[ts.macd_status] : 50;
    const macdTxt = ts.macd_status ? ("MACD " + ts.macd_status) : "MACD —";
    const vol = ts.vol_ratio != null ? +ts.vol_ratio : null;
    const volPct = vol != null ? vol * 25 : 50;
    const volTxt = vol != null ? ("量比 " + vol) : "量比 —";
    const rsi = ts.rsi != null ? +ts.rsi : null;
    const rsiPct = rsi != null ? rsi : 50;
    const rsiTxt = rsi != null ? ("RSI " + rsi) : "RSI —";

    // —— 三档价位（v3.1 标志：建仓 / 止损 / 目标）——
    const tl = p.tight || {};
    const buy = tl.buy != null ? fmt(tl.buy, 2) : "--";
    const sl = tl.stop_loss != null ? fmt(tl.stop_loss, 2) : "--";
    const tp = tl.take_profit != null ? fmt(tl.take_profit, 2) : "--";

    return `<div class="hb-card ${cls}" style="border-left-color:${color}">
      <div class="hb-top">
        <div class="hb-id">
          <b class="hb-name">${p.name || p.code}</b>
          <span class="hb-code">${p.code} · ${shares}</span>
        </div>
        <div class="hb-ring" style="--p:${scorePct};--rc:${color}">
          <svg viewBox="0 0 44 44" class="ring-svg">
            <circle cx="22" cy="22" r="18" class="ring-bg"/>
            <circle cx="22" cy="22" r="18" class="ring-fg"/>
          </svg>
          <span class="ring-num" style="color:${scoreColor}">${score > 0 ? "+" : ""}${score}</span>
        </div>
      </div>
      <div class="hb-px-row">
        <span class="hb-px"><b>${px}</b></span>
        <span class="hb-chg ${chgCls}">${chg}</span>
        <span class="hb-act" style="color:${color}">${label}</span>
      </div>
      <div class="hb-bars">
        ${_hbBar("KDJ", kdjPct, kdjTxt)}
        ${_hbBar("MACD", macdPct, macdTxt)}
        ${_hbBar("量能", volPct, volTxt)}
        ${_hbBar("RSI", rsiPct, rsiTxt)}
      </div>
      <div class="hb-levels">
        <div class="hb-lv lv-buy"><span>建仓</span><b>${buy}</b></div>
        <div class="hb-lv lv-sl"><span>止损</span><b>${sl}</b></div>
        <div class="hb-lv lv-tp"><span>目标</span><b>${tp}</b></div>
      </div>
    </div>`;
  }

  // r27：行情看板左侧拆两块 —— 上=持仓股实时监控（来自 state.positions），下=自选股实时监控（扫描前 5-10 只）
  // 共用 buildSelfList() 计算 candidates/watchlist 合并列表
  function _renderMonitorRow(it) {
    const act = it.action || "持有";
    const cls = _ssActionClass2(act);
    const actCls = act === "强烈买入" || act === "买入" || act === "加仓" ? "act-buy"
                 : act === "减仓" || act === "卖出" ? "act-sell" : "act-hold";
    const pxTxt = it.price != null
      ? `<span class="dm-px ${chgClass(it.change_pct)}">${fmt(it.price)}</span><span class="dm-chg ${chgClass(it.change_pct)}">${it.change_pct != null ? (it.change_pct >= 0 ? "+" : "") + fmt(it.change_pct) + "%" : ""}</span>`
      : `<span class="dm-px">--</span>`;
    const scoreTxt = it.score != null ? it.score : "—";
    const track = it.track || "";
    return `<div class="dm-row ${cls}" data-code="${it.code}" data-name="${it.name}">
      <span class="dm-act ${actCls}">${act}</span>
      <span class="dm-name">${it.name}<i class="dm-code">${it.code}</i></span>
      ${pxTxt}
      <span class="dm-score">${scoreTxt}</span>
      <span class="dm-track">${track}</span>
    </div>`;
  }
  function _ssActionClass2(act) {
    if (act === "强烈买入" || act === "买入" || act === "加仓") return "dm-buy";
    if (act === "减仓" || act === "卖出") return "dm-sell";
    return "dm-hold";
  }
  // 兼容旧名（hyphen 不合法 → camelCase）
  const _ss_action_class = _ssActionClass2;
  function renderHoldingsMonitor() {
    const el = document.getElementById("holdingsMonitor");
    const cnt = document.getElementById("holdingsMonitorCount");
    const empty = document.getElementById("holdingsEmpty");
    if (!el) return;
    // 持仓列表：名称/现价/涨跌幅/振幅/换手/量比/信号分/趋势(迷你K线) + 点击进决策面板
    const list = (state.posAdvice || []).filter(p => p && p.ok !== false && p.code);
    if (cnt) cnt.textContent = `共 ${list.length} 只`;
    if (!list.length) {
      if (empty) empty.style.display = "";
      el.innerHTML = "";
      return;
    }
    if (empty) empty.style.display = "none";
    const rows = list.map(p => {
      const code = p.code || "";
      const shares = +p.shares || 0;
      const cost = +p.cost || 0;
      const price = +p.price || 0;
      const profitPct = (cost > 0 && price > 0) ? (price - cost) / cost * 100 : null;
      return {
        code, name: p.name || code, shares, cost, price,
        chg: +p.change_pct,
        amp: +p.amplitude,
        turnover: +p.turnover,
        volRatio: +p.vol_ratio,
        score: p.advice_score != null ? p.advice_score : (p.score != null ? p.score : null),
        action: p.action || p.action_label || "持有",
        spark: p.spark || [],
      };
    });
    const clsPos = "tp-pos", clsNeg = "tp-neg";
    const actCls = a => {
      if (a === "买入" || a === "加仓") return "act-buy";
      if (a === "卖出" || a === "减仓") return "act-sell";
      return "act-hold";
    };
    el.innerHTML = rows.map(r => {
      const cCls = isFinite(r.chg) ? (r.chg >= 0 ? clsPos : clsNeg) : "";
      const pCls = (r.profitPct != null) ? (r.profitPct >= 0 ? clsPos : clsNeg) : "";
      const spark = _miniSpark(r.spark, r.chg >= 0);
      return `<tr class="hm-row" data-code="${r.code}" data-name="${r.name}">
        <td><b>${r.name}</b><i class="hm-code">${r.code}</i></td>
        <td class="r ${cCls}">${r.price ? r.price.toFixed(2) : "--"}</td>
        <td class="r ${cCls}">${isFinite(r.chg) ? (r.chg >= 0 ? "+" : "") + r.chg.toFixed(2) + "%" : "--"}</td>
        <td class="r">${r.amp ? r.amp.toFixed(2) + "%" : "--"}</td>
        <td class="r">${r.turnover ? r.turnover.toFixed(2) + "%" : "--"}</td>
        <td class="r">${r.volRatio ? r.volRatio.toFixed(2) : "--"}</td>
        <td class="r">${r.score != null ? r.score : "--"}</td>
        <td class="hm-trend">${spark}</td>
      </tr>`;
    }).join("");
    el.querySelectorAll(".hm-row").forEach(row =>
      row.addEventListener("click", () => openStock(row.dataset.code, row.dataset.name)));
  }
  // 迷你趋势 K 线（最近 N 日收盘）
  function _miniSpark(closes, up) {
    if (!closes || !closes.length) return '<span class="hm-no">--</span>';
    try {
      const w = 54, h = 18, n = closes.length;
      const min = Math.min(...closes), max = Math.max(...closes);
      const rng = (max - min) || 1;
      const pts = closes.map((v, i) => {
        const x = (i / (n - 1 || 1)) * (w - 2) + 1;
        const y = h - 2 - ((v - min) / rng) * (h - 4);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(" ");
      const col = up ? "#ef4444" : "#22c55e"; // A股红涨绿跌
      return `<svg class="mini-spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.2"/></svg>`;
    } catch (e) { return '<span class="hm-no">--</span>'; }
  }
  function renderSelfMonitor() {
    const el = document.getElementById("selfMonitor");
    const cnt = document.getElementById("selfMonitorCount");
    if (!el) return;
    // 来自 buildSelfList：取所有非"持仓"来源，按评分降序，前 10 只
    const list = buildSelfList().filter(it => it.origin !== "持仓");
    if (cnt) cnt.textContent = `信号扫描前 ${Math.min(list.length, 10)} / 共 ${list.length} 只`;
    if (!list.length) {
      el.innerHTML = '<div class="dash-monitor-empty">自动优选中…（首次约 1 分钟扫描成长池）</div>';
      return;
    }
    const top = list.slice(0, 10);
    el.innerHTML = top.map(_renderMonitorRow).join("");
    el.querySelectorAll(".dm-row").forEach(row =>
      row.addEventListener("click", () => openStock(row.dataset.code, row.dataset.name)));
  }
  // 兼容旧 renderSelfStocks 调用（任何调用点都同时刷新两块面板）
  function renderSelfStocks() {
    try { renderHoldingsMonitor(); } catch (e) { console.warn('[wb] renderHoldingsMonitor:', e && e.message); }
    try { renderSelfMonitor(); } catch (e) { console.warn('[wb] renderSelfMonitor:', e && e.message); }
  }

  // r37：板块扫描区手动刷新按钮 + 状态显示
  let _scanRunning = false;
  function _setScanStatus(text, cls) {
    const el = document.getElementById("scanFreshStatus");
    if (el) {
      el.textContent = text;
      el.classList.remove("running", "done", "fail");
      if (cls) el.classList.add(cls);
    }
  }
  // r38：扫描中按钮加 spinner 反馈
  function _setScanBtnLoading(loading) {
    const btn = document.getElementById("scanFreshBtn");
    const lbl = document.getElementById("scanFreshBtnLabel");
    const icn = btn && btn.querySelector(".scan-fresh-icon");
    if (!btn) return;
    btn.disabled = !!loading;
    if (loading) {
      btn.classList.add("loading");
      if (lbl) lbl.textContent = "扫描中…";
    } else {
      btn.classList.remove("loading");
      if (lbl) lbl.textContent = "刷新";
    }
  }
  async function manualScan() {
    if (_scanRunning) { _setScanStatus("扫描进行中，请稍候…", "running"); return; }
    const btn = document.getElementById("scanFreshBtn");
    _setScanBtnLoading(true);
    _scanRunning = true;
    _setScanStatus("扫描中…预计 10-30 秒", "running");
    try {
      await autoScan();
      _setScanStatus("刷新完成 " + new Date().toLocaleTimeString("zh-CN", { hour12: false }), "done");
    } catch (e) {
      _setScanStatus("刷新失败：" + (e && e.message || e), "fail");
    } finally {
      _scanRunning = false;
      _setScanBtnLoading(false);
    }
  }

  // 自动优选：触发候选扫描（不点扫描也自动跑），轮询进度并渲染
  async function autoScan() {
    const scope = $("#scopeSelect") ? $("#scopeSelect").value : "candidate";
    const strategy = $("#strategySelect") ? $("#strategySelect").value : "composite";
    try {
      await api("GET", "/api/screener?scope=" + scope + "&strategy=" + strategy + "&limit=120");
    } catch (e) { /* ignore */ }
    pollSelfScan(strategy);
  }
  async function pollSelfScan(strategy) {
    try {
      const st = await api("GET", "/api/scan_status");
      if (st && st.results && st.results.length) {
        state.candidates = st.results;
        renderSelfStocks();
      }
      if (st && st.running) setTimeout(() => pollSelfScan(strategy), 2000);
    } catch (e) { /* ignore */ }
  }

  async function addCurrentToWatch() {
    if (!state.current.code) { toast("请先选择一只股票"); return; }
    if (_inWatch(state.current.code)) { toast("已在自选"); return; }
    const m = state.watchMeta[state.current.code] || {};
    state.watchlist.push({
      code: state.current.code, name: m.name || state.current.name || state.current.code,
      add_time: new Date().toISOString(), add_price: m.price != null ? m.price : null, scan_buy: null,
    });
    renderWatchlist();
    try { const r = await saveWatchlist(); if (r && r.items) state.watchlist = r.items; } catch (e) { toast("已加入本地自选（云端保存失败）"); }
    await computeSignals();
  }

  async function pollQuotes() {
    if (!state.watchlist.length) return;
    const codes = state.watchlist.map(w => w.code);
    const chunked = [];
    for (let i = 0; i < codes.length; i += 80) chunked.push(codes.slice(i, i + 80));
    const rt = {};
    for (const ch of chunked) {
      const part = await api("GET", "/api/quotes?codes=" + ch.join(","));
      Object.assign(rt, part);
    }
    for (const code of codes) {
      const q = rt[code];
      if (q) state.watchMeta[code] = { ...(state.watchMeta[code] || {}), name: q.name, price: q.price, change: q.change, change_pct: q.change_pct, high: q.high, low: q.low };
    }
    renderWatchlist();
    // 更新头部
    if (state.current.code && rt[state.current.code]) {
      const q = rt[state.current.code];
      $("#curPrice").textContent = fmt(q.price);
      $("#curPrice").className = "cur-price " + chgClass(q.change);
      $("#curChange").textContent = `${q.change >= 0 ? "+" : ""}${fmt(q.change)}　${q.change_pct >= 0 ? "+" : ""}${fmt(q.change_pct)}%`;
      $("#curChange").className = "cur-change " + chgClass(q.change);
    }
  }

  async function computeSignals() {
    for (const code of state.watchlist.map(w => w.code)) {
      try {
        const a = await api("GET", "/api/signal?code=" + code + "&period=daily&limit=120");
        if (a.ok) state.watchMeta[code] = { ...(state.watchMeta[code] || {}), action: a.action, score: a.score, name: state.watchMeta[code]?.name || code };
      } catch (e) { /* ignore */ }
    }
    renderWatchlist();
  }

  // ---------- 打开股票 ----------
  async function openStock(code, name) {
    // r28：不再自动加入自选。持仓股就是持仓股，不应被点击"变成自选股"。
    // 自选股应只来自信号扫描结果（state.candidates）或用户主动「加自选」按钮。
    state.current = { code, name: name || code, period: state.current.period || "5m" };
    // r29：刷新右上方个股详情与交易计划
    renderStockDetail(code, name || code);
  }

  // ---------- 行情看板·个股详情（v3.1 右侧面板） ----------
  // 点击自选/搜索/持仓股时，拉实时行情 + 技术面分析，渲染评分圆环 + 2×2 技术进度条 + 三档价位
  // r29：完全照参考图重做。拉 /api/signal，里面已有 indicators + tight + tech_short
  // 直接映射到 UI：头部价 / SVG折线 / 指标横排 / 评分 / 6 维 / 三框 / 参数 / 按钮
  let __tpCurrent = { code: null, name: null, period: "5m", buy: null, stop: null, tgt: null, price: null };
  // r40：K线双标签模式（与顶部"周期"解耦）。intraday=分时(拉1m) / daily=日K+指标(拉daily)
  let __klineMode = "intraday";

  // /api/signal 里的 indicators.* 已经是最后一个值的 float，直接返回即可
  function lastNonNull(v) {
    if (v == null) return null;
    if (typeof v === "number") return isFinite(v) ? v : null;
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) if (v[i] != null) return v[i];
      return null;
    }
    return null;
  }

  // r29：本地 SMA（前端从 K 线算 MA20 斜率用，避免对单值调 slice 报错）
  function smaArr(values, n) {
    const out = new Array(values.length).fill(null);
    if (n <= 0 || values.length < n) return out;
    let s = 0;
    for (let i = 0; i < values.length; i++) {
      s += values[i];
      if (i >= n) s -= values[i - n];
      if (i >= n - 1) out[i] = s / n;
    }
    return out;
  }

  // r37：K线缓存（按 code 缓存最近一次信号返回的 bars/series），切换股票秒出图
  const _klineCache = Object.create(null);
  // r39：按 (code + period) 缓存最近一次拉到的 K 线，周期切换 / 同股票不同周期 复用
  const _klineCachePeriod = Object.create(null);

  async function renderStockDetail(code, name) {
    __tpCurrent.code = code;
    __tpCurrent.name = name || code;
    const $ = (s) => document.getElementById(s);
    const meta = $("tradePlanMeta");
    const _mode = __klineMode || "intraday";
    const _kc0 = _klineCachePeriod[code + "|" + _mode];
    // r40m：5 秒自动刷新时，缓存已存在 → meta 不要每次倒退到"加载中…"再前进，直接保留为缓存时间
    if (meta) meta.textContent = _kc0 ? _kc0.metaText : "加载中…";
    // 切换瞬间：先把右侧头部价格/涨跌/指标占位清空，避免上一个股票的数据残留
    const reset = ["tpName","tpCode","tpPrice","tpChg"];
    reset.forEach(id => { const e = $(id); if (e) e.textContent = "--"; });
    document.querySelectorAll("#tpIndicators .tp-ind b").forEach(b => b.textContent = "--");
    // r40：优先用 K线周期缓存（按 mode 取）秒出，避免切股票后空白等待接口
    const _kc = _klineCachePeriod[code + "|" + _mode];
    if (_kc && _kc.bars && _kc.bars.length) {
      try { renderTpChart(_kc.bars, _kc.indicators || {}, _mode, !!_kc.isDemo); } catch (e) {}
    } else {
      const tpChart = $("tpChart"); if (tpChart) tpChart.innerHTML = '<div class="tp-skeleton">K 线加载中…</div>';
    }
    // 短线策略占位
    const tsBody = $("tpStrategyBody");
    if (tsBody) tsBody.innerHTML = '<div class="tp-strategy-hint">短线策略计算中…</div>';

    try {
      // r37：信号 + 隔夜抢仓 并发（用户反馈「切换股票后 K 线很久没反应」）
      const [sig, ov] = await Promise.all([
        api("GET", "/api/signal?code=" + encodeURIComponent(code) + "&period=daily&limit=180").catch(() => null),
        api("GET", "/api/strategy/overnight?code=" + encodeURIComponent(code)).catch(() => null),
      ]);
      if (!sig || !sig.ok) {
        if (meta) meta.textContent = "数据源暂不可达，请稍后重试";
        return;
      }
      _renderTradePlan(sig, code, name);
      // 缓存本次 K 线（下次切回立即出图）
      try {
        const last = sig.price, prev = sig.prev_close;
        const chg = (last != null && prev != null && prev > 0) ? ((last - prev) / prev * 100) : null;
        _klineCache[code] = {
          bars: sig.bars || [], series: sig.series || {},
          last: { name: name || sig.name || code, code, price: last, chg },
          ts: Date.now(),
        };
      } catch (e) {}
      // 渲染隔夜抢仓结果
      try { _renderStrategyResult("overnight", ov); }
      catch (e) {
        if (tsBody) tsBody.innerHTML = '<div class="tp-strategy-hint">短线策略加载失败：' + (e && e.message || e) + '</div>';
      }
      // r39：按当前周期（默认 5m）拉 /api/kline 重绘
      try { await renderKlineAtPeriod(); } catch (e) { console.warn('[wb] kline period:', e && e.message); }
      if (meta) meta.textContent = "更新于 " + new Date().toLocaleTimeString("zh-CN", {hour12: false});
    } catch (e) {
      if (meta) meta.textContent = "加载失败：" + (e && e.message || e);
    }
  }

  function _renderTradePlan(sig, code, name) {
    const $ = (s) => document.getElementById(s);
    const price = sig.price;
    const prev = sig.prev_close;
    const chg = (price != null && prev != null && prev > 0) ? ((price - prev) / prev * 100) : null;
    const chgAbs = (price != null && prev != null) ? (price - prev) : null;
    const down = chg != null && chg < 0;
    const up = chg != null && chg >= 0;

    // 头部
    $("tpName").textContent = name || sig.name || code;
    $("tpCode").textContent = code;
    const pEl = $("tpPrice"); pEl.textContent = price != null ? price.toFixed(2) : "--";
    pEl.className = "tp-price" + (down ? " tp-down" : "");
    const cEl = $("tpChg");
    if (chg != null) {
      cEl.textContent = `${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%${chgAbs != null ? " " + (chgAbs >= 0 ? "+" : "") + chgAbs.toFixed(2) : ""}`;
      cEl.className = "tp-chg" + (down ? " tp-down" : "");
    } else { cEl.textContent = "--"; cEl.className = "tp-chg"; }

    // 指标横排
    const ind = sig.indicators || {};
    const ma5 = lastNonNull(ind.ma && ind.ma.ma5);
    const ma10 = lastNonNull(ind.ma && ind.ma.ma10);
    const ma20 = lastNonNull(ind.ma && ind.ma.ma20);
    const macdDif = lastNonNull(ind.macd && ind.macd.dif);
    const macdDea = lastNonNull(ind.macd && ind.macd.dea);
    const kdjK = lastNonNull(ind.kdj && ind.kdj.k);
    const kdjD = lastNonNull(ind.kdj && ind.kdj.d);
    const kdjJ = lastNonNull(ind.kdj && ind.kdj.j);
    const rsi12 = lastNonNull(ind.rsi && ind.rsi.rsi12);
    const bollL = lastNonNull(ind.boll && ind.boll.lower);
    const bollU = lastNonNull(ind.boll && ind.boll.upper);
    const indEls = document.querySelectorAll("#tpIndicators .tp-ind b");
    const indTxt = [
      ma5 != null ? ma5.toFixed(2) : "--",
      ma10 != null ? ma10.toFixed(2) : "--",
      ma20 != null ? ma20.toFixed(2) : "--",
      (macdDif != null && macdDea != null) ? `${macdDif.toFixed(2)}/${macdDea.toFixed(2)}` : "--",
      (kdjK != null && kdjD != null && kdjJ != null) ? `${kdjK.toFixed(1)}/${kdjD.toFixed(1)}/${kdjJ.toFixed(1)}` : "--",
      rsi12 != null ? rsi12.toFixed(1) : "--",
      (bollL != null && bollU != null) ? `${bollL.toFixed(2)}~${bollU.toFixed(2)}` : "--",
    ];
    indEls.forEach((b, i) => b.textContent = indTxt[i] || "--");

    // 量化评分（综合动能）：score 范围 -100..+100 → 进度圈百分比 0..100
    const score = sig.score != null ? sig.score : 0;
    const scorePct = Math.max(0, Math.min(100, (score + 100) / 2));
    const snEl = $("tpScoreNum");
    if (snEl) {
      snEl.style.setProperty("--p", (scorePct * 3.6) + "deg");
      snEl.innerHTML = `<span>${score > 0 ? "+" : ""}${score}</span>`;
    }
    const act = sig.action || "持有";
    // ===== 五档操作评级（强烈买入/买入/持仓观望/卖出/强烈卖出）=====
    let tag = "持仓观望", barCls = "lvl-hold", note = "动能中性，区间操作，单维度信号仅观望";
    const strong = (act.includes("买入") || act.includes("加仓")) && score >= 60;
    const buy = (act.includes("买入") || act.includes("加仓") || act.includes("分批")) && score >= 35;
    const sell = (act.includes("卖出") || act.includes("减仓")) && score <= -35;
    const strongSell = (act.includes("卖出") || act.includes("减仓")) && score <= -60;
    if (strongSell) { tag = "强烈卖出"; barCls = "lvl-sell"; note = "多维共振看空，建议减仓避险"; }
    else if (sell) { tag = "卖出"; barCls = "lvl-sell"; note = "动能转弱，注意风险、及时止盈止损"; }
    else if (strong) { tag = "强烈买入"; barCls = "lvl-buy"; note = "技术+资金+情绪多维共振，可积极介入"; }
    else if (buy) { tag = "买入"; barCls = "lvl-buy"; note = "动能偏多，可逢低吸纳"; }
    else if (score >= 10) { tag = "持仓观望"; barCls = "lvl-buy"; note = "动能略偏多，持有观察"; }
    else if (score <= -10) { tag = "持仓观望"; barCls = "lvl-sell"; note = "动能略偏空，观望为主"; }
    const scoreBar = document.querySelector(".tp-score-bar");
    if (scoreBar) {
      scoreBar.classList.remove("tp-buy","tp-hold","tp-sell","lvl-buy","lvl-hold","lvl-sell");
      scoreBar.classList.add(barCls);
    }
    const tagEl = $("tpScoreTag");
    if (tagEl) { tagEl.textContent = tag; tagEl.className = "tp-score-tag " + barCls; }
    const noteEl = $("tpScoreNote");
    if (noteEl) noteEl.textContent = note;
    __tpCurrent.level = tag;

    // 6 维评分（趋势/均线/MACD/KDJ/RSI/量能）：范围 -100..+100
    const dims = _calcSixDims(sig);
    _setRadar("tpRadTrend", "tpRadTrendV", dims.trend);
    _setRadar("tpRadMa",    "tpRadMaV",    dims.ma);
    _setRadar("tpRadMacd",  "tpRadMacdV",  dims.macd);
    _setRadar("tpRadKdj",   "tpRadKdjV",   dims.kdj);
    _setRadar("tpRadRsi",   "tpRadRsiV",   dims.rsi);
    _setRadar("tpRadVol",   "tpRadVolV",   dims.vol);

    // ===== 压力 / 支撑（技术面 BOLL + MA）=====
    const bollL2 = lastNonNull(ind.boll && ind.boll.lower);
    const bollU2 = lastNonNull(ind.boll && ind.boll.upper);
    const ma20v = lastNonNull(ind.ma && ind.ma.ma20);
    const sup = bollL2 != null ? bollL2 : (ma20v != null ? ma20v * 0.98 : null);
    const res = bollU2 != null ? bollU2 : (ma20v != null ? ma20v * 1.02 : null);
    const supEl = $("aiSupport"), resEl = $("aiResist");
    if (supEl) supEl.textContent = sup != null ? sup.toFixed(2) : "--";
    if (resEl) resEl.textContent = res != null ? res.toFixed(2) : "--";

    // ===== 短期参考买卖价（贴近现价 ±1%，可立即挂单）=====
    const tight = sig.tight || {};
    let buyPx = tight.short_buy != null ? tight.short_buy
              : (price != null ? round2(price * 0.99) : null);
    let stopPx = tight.short_stop_loss != null ? tight.short_stop_loss
               : (buyPx != null ? round2(buyPx * 0.985) : null);
    let tgtPx = tight.short_take_profit != null ? tight.short_take_profit
              : (price != null ? round2(price * 1.02) : null);
    __tpCurrent.buy = buyPx; __tpCurrent.stop = stopPx; __tpCurrent.tgt = tgtPx;
    const buyEl = $("tpBuy"), stopEl = $("tpStop"), tgtEl = $("tpTarget");
    if (buyEl) { buyEl.textContent = buyPx != null ? buyPx.toFixed(2) : "--"; buyEl.className = "tp-box-val tp-pos"; }
    if (stopEl) stopEl.textContent = stopPx != null ? stopPx.toFixed(2) : "--";
    if (tgtEl) tgtEl.textContent = tgtPx != null ? tgtPx.toFixed(2) : "--";
    const buySub = $("tpBuySub");
    if (buySub) buySub.textContent = price != null && buyPx != null
      ? `现价 ${price.toFixed(2)} 回踩 ${((buyPx - price) / price * 100).toFixed(1)}%` : "";

    // r37：删掉 .tp-params（账户总资金/单笔风险/建议仓位）后，建议股数也无法算
    const sharesEl = $("aiShares");
    if (sharesEl) sharesEl.textContent = "--";

    // 当日涨跌预估（来自 forecast 或 reasons 末句，best-effort）
    const fcEl = $("aiForecast");
    if (fcEl) {
      const fc = sig.forecast || (sig.position && sig.position.forecast);
      fcEl.textContent = fc && fc.trend ? `${fc.trend}${fc.pct != null ? " " + (fc.pct>0?"+":"") + fc.pct + "%" : ""}` : "--";
    }

    // 多维决策依据（技术面 + 板块资金 + 大盘情绪）
    _renderBasis(sig, code);

    // r37：删除 _computeSuggestedPosition（账户总资金/单笔风险 输入区已删）

    // r39：K 线图改为按当前 __tpCurrent.period 拉取（默认 5m），这里不再直接画 sig.bars 的日线
    // 由 renderStockDetail 在 _renderTradePlan 之后调 renderKlineAtPeriod() 完成
  }

  // 五档评级 + 多维共振依据
  function _renderBasis(sig, code) {
    const body = document.getElementById("aiBasisBody");
    if (!body) return;
    const parts = [];
    // 技术面
    const reasons = sig.reasons || (sig.position && sig.position.reasons) || [];
    const tech = reasons.length ? reasons.slice(0, 4) : ["技术面数据加载中…"];
    parts.push(`<div class="basis-sec"><b>📐 技术面</b>${tech.map(t => `<div class="basis-li">· ${t}</div>`).join("")}</div>`);
    // 板块资金
    const regime = sig.regime || (sig.position && sig.position.regime);
    if (regime) {
      const s = `所属板块 ${regime.sector || regime.track || "--"}，当日${regime.trend_pct != null ? (regime.trend_pct>0?"+":"")+regime.trend_pct+"%" : "--"}，主力${regime.fund_net != null ? (regime.fund_net>0?"净流入":"净流出")+Math.abs(regime.fund_net)+"亿" : "资金未知"}，涨跌家数比 ${(regime.up_ratio!=null?Math.round(regime.up_ratio*100):"--")}%`;
      parts.push(`<div class="basis-sec"><b>🏭 板块资金</b><div class="basis-li">· ${s}</div></div>`);
    }
    // 大盘情绪
    const ms = state.sentiment;
    if (ms && ms.ok) {
      parts.push(`<div class="basis-sec"><b>🌐 大盘情绪</b><div class="basis-li">· ${ms.sentiment_label}（评分${ms.sentiment_score}）：${ms.tip}</div><div class="basis-li">· 涨跌家数 涨${ms.breadth.up}/跌${ms.breadth.down}，风险等级 ${ms.risk_level}</div></div>`);
    }
    parts.push(`<div class="basis-sec basis-warn"><b>⚠ 共振规则</b><div class="basis-li">· 单一指标信号仅标注观望，禁止推荐开仓；技术+板块+大盘三者共振才给强烈买卖。</div></div>`);
    body.innerHTML = parts.join("");
  }

  function _calcSixDims(sig) {
    const ind = sig.indicators || {};
    const bars = sig.bars || [];
    const closes = bars.map(b => b.close).filter(v => v != null);
    const vols = bars.map(b => b.volume).filter(v => v != null);
    const dims = { trend: 0, ma: 0, macd: 0, kdj: 0, rsi: 0, vol: 0 };

    // 趋势：最近 5 根 K 线 MA20 斜率（用 K 线自算，避免对单值调 slice）
    try {
      const bars = sig.bars || [];
      if (bars.length >= 25) {
        const ma20 = smaArr(bars.map(b => b.close), 20);
        const tail = ma20.slice(-10).filter(v => v != null);
        if (tail.length >= 2) {
          const slope = (tail[tail.length - 1] - tail[0]) / tail[0];
          dims.trend = Math.max(-100, Math.min(100, slope * 1000));
        }
      }
    } catch (e) {}
    // 均线多头排列：MA5 > MA10 > MA20
    try {
      const ma5 = lastNonNull(ind.ma && ind.ma.ma5);
      const ma10 = lastNonNull(ind.ma && ind.ma.ma10);
      const ma20 = lastNonNull(ind.ma && ind.ma.ma20);
      const price = sig.price;
      if (ma5 != null && ma10 != null && ma20 != null && price > 0) {
        let s = 0;
        if (ma5 > ma10) s += 30; if (ma10 > ma20) s += 30;
        if (price > ma5) s += 20; if (price > ma20) s += 20;
        dims.ma = Math.max(-100, Math.min(100, s - 50));
      }
    } catch (e) {}
    // MACD：DIF-DEA 标准化
    try {
      const dif = lastNonNull(ind.macd && ind.macd.dif);
      const dea = lastNonNull(ind.macd && ind.macd.dea);
      const price = sig.price || 0;
      if (dif != null && dea != null && price > 0) {
        dims.macd = Math.max(-100, Math.min(100, (dif - dea) / price * 1000));
      }
    } catch (e) {}
    // KDJ：J 偏离 50
    try {
      const j = lastNonNull(ind.kdj && ind.kdj.j);
      if (j != null) dims.kdj = Math.max(-100, Math.min(100, (j - 50) * 1.5));
    } catch (e) {}
    // RSI：偏离 50
    try {
      const r = lastNonNull(ind.rsi && ind.rsi.rsi12);
      if (r != null) dims.rsi = Math.max(-100, Math.min(100, (r - 50) * 2));
    } catch (e) {}
    // 量能：最近量比 - 1
    try {
      const ts = sig.tech_short || {};
      const vr = ts.vol_ratio != null ? +ts.vol_ratio : null;
      if (vr != null) dims.vol = Math.max(-100, Math.min(100, (vr - 1) * 100));
    } catch (e) {}
    return dims;
  }

  function _setRadar(fillId, valId, v) {
    const fill = document.getElementById(fillId);
    const val = document.getElementById(valId);
    if (!fill || !val) return;
    if (v == null) { fill.style.width = "0"; val.textContent = "--"; return; }
    const abs = Math.abs(v);
    const widthPct = (abs / 100) * 50; // 半幅最大 50%
    if (v >= 0) {
      fill.className = "tp-radar-fill tp-pos";
      fill.style.left = "50%";
      fill.style.width = widthPct + "%";
    } else {
      fill.className = "tp-radar-fill tp-neg";
      fill.style.left = (50 - widthPct) + "%";
      fill.style.width = widthPct + "%";
    }
    val.textContent = (v >= 0 ? "+" : "") + v.toFixed(0);
    val.className = "tp-radar-val " + (v >= 0 ? "tp-pos" : (v < 0 ? "tp-neg" : ""));
  }

  // r37：删除 _computeSuggestedPosition（账户总资金/单笔风险 输入区已删，建议仓位由用户自行判断）

  // 大盘全局情绪
  async function loadMarketSentiment() {
    try {
      const d = await api("GET", "/api/market_sentiment");
      if (!d || !d.ok) return;
      state.sentiment = d;
      _renderSentiment(d);
      // 若决策面板已渲染，联动刷新多维依据里的大盘部分
      if (__tpCurrent.code && document.querySelector('.view-dashboard:not([hidden])')) {
        try {
          const sig = await api("GET", "/api/signal?code=" + encodeURIComponent(__tpCurrent.code) + "&period=daily&limit=180");
          if (sig && sig.ok) _renderBasis(sig, __tpCurrent.code);
        } catch (e) {}
      }
    } catch (e) { console.warn('[wb] sentiment:', e && e.message); }
  }
  function _renderSentiment(d) {
    const lbl = document.getElementById('sentLabel');
    const sub = document.getElementById('sentSub');
    if (lbl) {
      const lvl = d.sentiment_level;
      const cls = (lvl === '强' || lvl === '偏强') ? 'buy' : (lvl === '弱' ? 'sell' : 'hold');
      lbl.textContent = d.sentiment_label || '--';
      lbl.className = 'ai-sent-val lvl-' + cls;
    }
    if (sub) {
      const sh = d.indices && d.indices.sh;
      const br = d.breadth || {};
      sub.textContent = `上证${sh && sh.change_pct != null ? (sh.change_pct > 0 ? "+" : "") + sh.change_pct + "%" : ""} · 涨跌 ${br.up ?? "--"}/${br.down ?? "--"} · 涨停${br.limit_up ?? "-"} 跌停${br.limit_down ?? "-"}`;
    }
    const rw = document.getElementById('riskWarning');
    if (rw) rw.textContent = '⚠ ' + (d.risk_tip || '仅供参考，不构成投资建议');
    const conn = document.getElementById('connStatus');
    if (conn) conn.innerHTML = '<i class="dot dot-green"></i> 行情连接：正常 · 情绪更新 ' + (d.ts || '');
  }

  // ====================== r40：ECharts 双标签渲染（替换原手绘 SVG _drawTpChart） ======================
  // 设计要点：
  //  - 分时 = line + areaStyle 渐变 + 1 根金黄 MA(#ffc120)；日K = candlestick（无 areaStyle）+ MA5金/MA10蓝/MA20灰
  //  - 两套 series 完全独立，用 setOption(opt, true) 不合并，参数零污染
  //  - 配色统一 A股：涨红 #ff4c4c / 跌绿 #36d170；背景 #121214
  let _tpChartInst = null;
  let _tpResizeBound = false;
  let _tpLastMode = null;       // r40f：上次渲染的 mode（intraday/daily），用于决定 setOption 用 merge 还是 notMerge
  let _tpIntraInited = false;   // r40g：分时 layout 是否已首次注入（首次完整 setOption 后只走 series 增量更新）

  // ---- 前端指标计算（仅用于"演示数据"兜底；真实数据由后端 /api/kline 的 indicators 提供） ----
  function _emaVals(vals, n) {
    const out = new Array(vals.length).fill(null);
    if (!vals.length) return out;
    const k = 2 / (n + 1); let prev = vals[0]; out[0] = vals[0];
    for (let i = 1; i < vals.length; i++) { prev = vals[i] * k + prev * (1 - k); out[i] = prev; }
    return out;
  }
  function _rsiVals(closes, n) {
    const out = new Array(closes.length).fill(null);
    let g = 0, l = 0;
    for (let i = 1; i < closes.length; i++) {
      const ch = closes[i] - closes[i - 1];
      const gg = ch > 0 ? ch : 0, ll = ch < 0 ? -ch : 0;
      if (i <= n) {
        g += gg; l += ll;
        if (i === n) { const rs = l === 0 ? 100 : g / l; out[i] = l === 0 ? 100 : +(100 - 100 / (1 + rs)).toFixed(2); }
      } else {
        g = (g * (n - 1) + gg) / n; l = (l * (n - 1) + ll) / n;
        const rs = l === 0 ? 100 : g / l; out[i] = l === 0 ? 100 : +(100 - 100 / (1 + rs)).toFixed(2);
      }
    }
    return out;
  }
  function _macdFull(closes) {
    const e12 = _emaVals(closes, 12), e26 = _emaVals(closes, 26);
    const dif = closes.map((_, i) => (e12[i] != null && e26[i] != null) ? +(e12[i] - e26[i]).toFixed(3) : null);
    const dense = dif.filter(x => x != null);
    const deaDense = _emaVals(dense, 9);
    let j = 0;
    const dea = dif.map(x => x == null ? null : (deaDense[j] != null ? +(deaDense[j++]).toFixed(3) : null));
    const hist = dif.map((x, i) => (x != null && dea[i] != null) ? +(x - dea[i]).toFixed(3) : null);
    return { dif, dea, hist };
  }
  function _bollFull(closes, n, m) {
    n = n || 20; m = m || 2;
    const mid = smaArr(closes, n);
    const upper = new Array(closes.length).fill(null), lower = new Array(closes.length).fill(null);
    for (let i = n - 1; i < closes.length; i++) {
      const s = closes.slice(i - n + 1, i + 1);
      const m2 = s.reduce((a, b) => a + b, 0) / n;
      const sd = Math.sqrt(s.reduce((a, b) => a + (b - m2) * (b - m2), 0) / n);
      upper[i] = +(m2 + m * sd).toFixed(2); lower[i] = +(m2 - m * sd).toFixed(2);
    }
    return { upper, lower, mid };
  }
  function _kdjFull(closes, highs, lows, n) {
    n = n || 9;
    const k = new Array(closes.length).fill(null), d = new Array(closes.length).fill(null), j = new Array(closes.length).fill(null);
    let pK = 50, pD = 50;
    for (let i = n - 1; i < closes.length; i++) {
      const H = Math.max.apply(null, highs.slice(i - n + 1, i + 1));
      const L = Math.min.apply(null, lows.slice(i - n + 1, i + 1));
      const c = closes[i];
      const rsv = H === L ? 50 : (c - L) / (H - L) * 100;
      const K = pK * 2 / 3 + rsv / 3, D = pD * 2 / 3 + K / 3;
      k[i] = +K.toFixed(2); d[i] = +D.toFixed(2); j[i] = +(3 * K - 2 * D).toFixed(2);
      pK = K; pD = D;
    }
    return { k, d, j };
  }
  function computeIndicatorsFull(closes, highs, lows) {
    return {
      ma5: smaArr(closes, 5), ma10: smaArr(closes, 10), ma20: smaArr(closes, 20),
      kdj: _kdjFull(closes, highs, lows, 9),
      macd: _macdFull(closes),
      rsi: { rsi6: _rsiVals(closes, 6), rsi12: _rsiVals(closes, 12), rsi24: _rsiVals(closes, 24) },
      boll: _bollFull(closes, 20, 2)
    };
  }

  // ---- 演示数据兜底（接口暂不可达时，避免空白） ----
  function buildDemoBars(mode) {
    const n = mode === "intraday" ? 240 : 180;
    const base = 1685 + Math.random() * 40;
    let price = base;
    const bars = [];
    let t = mode === "intraday"
      ? new Date(2026, 7, 14, 9, 30, 0, 0).getTime()
      : (function () { const d = new Date(2026, 7, 14); d.setDate(d.getDate() - 260); return d.getTime(); })();
    for (let i = 0; i < n; i++) {
      const open = price;
      const step = (Math.random() - 0.48) * (mode === "intraday" ? 1.3 : 3.5);
      let close = open + step; if (close <= 0) close = open;
      const hi = Math.max(open, close) + Math.random() * (mode === "intraday" ? 0.8 : 2.2);
      const lo = Math.min(open, close) - Math.random() * (mode === "intraday" ? 0.8 : 2.2);
      const vol = Math.round((mode === "intraday" ? 1800 : 9000) * (0.5 + Math.random()) * (0.6 + Math.abs(step) * 0.4)) * 100;
      let dateStr, nd;
      if (mode === "intraday") {
        const d = new Date(t);
        dateStr = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
        nd = new Date(t); nd.setMinutes(nd.getMinutes() + 1);
        if (nd.getHours() === 11 && nd.getMinutes() > 30) { nd.setHours(13, 0, 0, 0); }
      } else {
        const d = new Date(t);
        dateStr = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
        nd = new Date(t); nd.setDate(nd.getDate() + 1);
        while (nd.getDay() === 0 || nd.getDay() === 6) { nd.setDate(nd.getDate() + 1); }
      }
      bars.push({ date: dateStr, open: +open.toFixed(2), close: +close.toFixed(2), high: +hi.toFixed(2), low: +lo.toFixed(2), volume: vol });
      price = close; t = nd.getTime();
    }
    const closes = bars.map(b => b.close), highs = bars.map(b => b.high), lows = bars.map(b => b.low);
    return { bars, indicators: computeIndicatorsFull(closes, highs, lows) };
  }

  // ---- 指标胶囊（MA5/MA10/MA20/MACD/KDJ/RSI/BOLL）填末值 ----
  function fillTpIndicators(ind) {
    if (!ind) return;
    const inds = document.querySelectorAll("#tpIndicators .tp-ind");
    if (!inds || inds.length < 7) return;
    const ln = (a) => { if (!a) return null; for (let i = a.length - 1; i >= 0; i--) { const v = a[i]; if (v != null && !isNaN(v)) return +v; } return null; };
    const setB = (idx, txt) => { const e = inds[idx].querySelector("b"); if (e) e.textContent = txt; };
    const m5 = ln(ind.ma5), m10 = ln(ind.ma10), m20 = ln(ind.ma20);
    setB(0, m5 == null ? "--" : m5.toFixed(2));
    setB(1, m10 == null ? "--" : m10.toFixed(2));
    setB(2, m20 == null ? "--" : m20.toFixed(2));
    if (ind.macd) { const d = ln(ind.macd.dif), a = ln(ind.macd.dea); setB(3, (d == null ? "--" : d.toFixed(2)) + " / " + (a == null ? "--" : a.toFixed(2))); }
    if (ind.kdj) { const k = ln(ind.kdj.k), d = ln(ind.kdj.d), j = ln(ind.kdj.j); setB(4, (k == null ? "--" : k.toFixed(1)) + " / " + (d == null ? "--" : d.toFixed(1)) + " / " + (j == null ? "--" : j.toFixed(1))); }
    if (ind.rsi) { const r = ln(ind.rsi.rsi6) != null ? ln(ind.rsi.rsi6) : ln(ind.rsi.rsi12); setB(5, r == null ? "--" : r.toFixed(1)); }
    if (ind.boll) { const u = ln(ind.boll.upper), l = ln(ind.boll.lower); setB(6, (u == null ? "--" : u.toFixed(2)) + " / " + (l == null ? "--" : l.toFixed(2))); }
  }

  // ---- 主渲染入口 ----
  function renderTpChart(bars, indicators, mode, isDemo) {
    const el = document.getElementById("tpChart");
    if (!el || !window.echarts) return;
    if (!bars || bars.length === 0) { if (_tpChartInst) _tpChartInst.clear(); return; }
    // 仅看板可见时绘制（隐藏时容器尺寸为 0，先缓存，切回看板时由 renderStockDetail 重绘）
    if (!_docQuery(".view-dashboard:not([hidden])")) return;
    if (!_tpChartInst) {
      el.innerHTML = "";
      _tpChartInst = window.echarts.init(el, null, { renderer: "canvas" });
      // r40h：容器初始 0 高度时 init 拿到空画布 → CSS 撑高后强制 resize 让 ECharts 重新测量
      try { _tpChartInst.resize(); } catch (e) {}
      if (!_tpResizeBound) {
        _tpResizeBound = true;
        // r40i：用 rAF 节流 resize，避免在 RO callback 里同步触发下一轮 ResizeObserver 循环警告
        let _lastW = 0, _lastH = 0, _resizeRaf = 0;
        function _doResize() {
          _resizeRaf = 0;
          if (!_tpChartInst || !el) return;
          const w = el.clientWidth, h = el.clientHeight;
          if (w === _lastW && h === _lastH) return;   // 尺寸未变不触发，斩断循环
          _lastW = w; _lastH = h;
          try { _tpChartInst.resize(); } catch (e) {}
        }
        window.addEventListener("resize", function () {
          if (_resizeRaf) return;
          _resizeRaf = requestAnimationFrame(_doResize);
        }, { passive: true });
        try {
          if (window.ResizeObserver) {
            const ro = new ResizeObserver(function () {
              if (_resizeRaf) return;
              _resizeRaf = requestAnimationFrame(_doResize);
            });
            ro.observe(el);
          }
        } catch (e) {}
      }
    }
    // r40g：增量刷新 —— 首次/跨模式用 layout + data 完整 setOption(true) 重建；
    //          同模式（分时↔分时）只 setOption({xAxis, series})，grid/yAxis/tooltip/dataZoom/backgroundColor 全跳过 → 不再"卡一下"
    if (mode === "intraday") {
      const layout = _tpIntraLayout();
      const data = _tpIntraData(bars);
      // 首次 OR 跨模式：完整 layout + data 重建
      if (!_tpLastMode || _tpLastMode !== mode || !_tpIntraInited) {
        // 把 data 合并到 layout（首次需要完整）—— 5 个 series：priceBg / price / avg / volBg / vol
        layout.xAxis[0].data = data.xAxis[0].data;
        layout.xAxis[1].data = data.xAxis[1].data;
        layout.yAxis[0].min = data.yAxis[0].min;   // r40k：锚定昨收 ±5%，防"变大变小"
        layout.yAxis[0].max = data.yAxis[0].max;
        layout.series[0].data = data.series[0].data;     // priceBg
        layout.series[0].areaStyle = data.series[0].areaStyle;
        layout.series[1].data = data.series[1].data;     // price
        layout.series[1].lineStyle = data.series[1].lineStyle;
        layout.series[1].areaStyle = data.series[1].areaStyle;
        layout.series[2].data = data.series[2].data;     // avg
        layout.series[3].data = data.series[3].data;     // volBg
        layout.series[3].areaStyle = data.series[3].areaStyle;
        layout.series[4].data = data.series[4].data;     // vol
        _tpChartInst.setOption(layout, true);   // notMerge=true 强制重建
        try { _tpChartInst.resize(); } catch (e) {}   // r40h：setOption(true) 后立即 resize，让 grid/canvas 按真实容器尺寸铺满
        _tpIntraInited = true;
      } else {
        // 同模式：仅更新 series + xAxis.data + yAxis[0].min/max，grid/yAxis[0]其它属性全不动
        _tpChartInst.setOption({
          xAxis: [{ data: data.xAxis[0].data }, { data: data.xAxis[1].data }],
          yAxis: [{ min: data.yAxis[0].min, max: data.yAxis[0].max }, {}],
          series: [
            { name: "priceBg", data: data.series[0].data, areaStyle: data.series[0].areaStyle },
            { name: "price",   data: data.series[1].data, lineStyle: data.series[1].lineStyle, areaStyle: data.series[1].areaStyle },
            { name: "avg",     data: data.series[2].data },
            { name: "volBg",   data: data.series[3].data, areaStyle: data.series[3].areaStyle },
            { name: "vol",     data: data.series[4].data }
          ]
        }, { lazyUpdate: true });
      }
    } else {
      // 日K模式：同模式且已初始化 → merge 只更新 series（candlestick 数据平滑跟随，不整图重建闪动）；跨模式/首次才 notMerge 重建
      const opt = buildDailyOption(bars, indicators);
      if (_tpIntraInited && _tpLastMode === "daily") {
        _tpChartInst.setOption({ xAxis: opt.xAxis, yAxis: opt.yAxis, series: opt.series }, { lazyUpdate: true });
      } else {
        _tpChartInst.setOption(opt, true);
      }
    }
    _tpLastMode = mode;
    fillTpIndicators(indicators);
  }

  // ---- 均价（累计成交额/累计成交量）----
  function _calcAvgPrice(bars) {
    let cumVol = 0, cumPV = 0;
    return (bars || []).map(b => {
      const v = +b.volume || 0, p = +b.close || 0;
      cumVol += v; cumPV += v * p;
      return cumVol > 0 ? cumPV / cumVol : p;
    });
  }

  let _tpLastBars = [];   // 给 tooltip formatter 读最新 bars（闭包逃逸，避免每次重建 formatter 闭包）
let _tpLastAvg = [];     // 同上，给 tooltip formatter 用均价

// ---- r40g：把 buildIntradayOption 拆为静态 layout + 动态 series，刷新时只更新 series/xAxis，grid/yAxis 完全不动 → 消"卡一下" ----
function _tpIntraLayout() {
    return {
      backgroundColor: "#121214", animation: false,
      textStyle: { fontFamily: "Inter, sans-serif", color: "#aaaaaa" },
      // 2 个 grid 顶天立地填满容器（不留下方空白）：
      //   grid[0] 主图：top 12 + height 78%   → 顶部 ~ 78%H
      //   grid[1] 量能：top 80% + height 16%  → 80% ~ 96%H（紧贴下方）
      //   顶部 12px 留价格坐标轴，底部 4% 给底部 xAxis 时间标签
      grid: [
        { left: 50, right: 60, top: 12,       height: "78%" },
        { left: 50, right: 60, top: "80%",    height: "16%" }
      ],
      dataZoom: [{ type: "inside", xAxisIndex: [0, 1], start: 0, end: 100, zoomLock: false }],
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "cross", lineStyle: { color: "#5a5a60", type: "dashed" }, crossStyle: { color: "#5a5a60" }, label: { backgroundColor: "#1e1e22" } },
        backgroundColor: "rgba(15,15,15,0.95)", borderColor: "#444", textStyle: { color: "#e5e7eb", fontSize: 11, fontFamily: "Inter" },
        // formatter 用 _tpLastBars（模块级），避免每次重建闭包
        formatter: function (ps) {
          const i = ps[0].dataIndex, b = _tpLastBars[i];
          if (!b) return "";
          const col = (+b.close >= +b.open) ? "#ff4c4c" : "#36d170";
          return '<div style="font-size:11px;font-family:Inter"><b style="color:#f3f4f6">' + (b.date || "") + '</b></div>'
            + '<div style="font-size:11px">价 <b style="color:#3b82f6">' + (+b.close).toFixed(2) + '</b>  均 <b style="color:#ffc120">' + (((_tpLastAvg && _tpLastAvg[i]) != null) ? (+_tpLastAvg[i]).toFixed(2) : "--") + '</b></div>'
            + '<div style="font-size:11px;color:' + col + '">开 ' + (+b.open).toFixed(2) + '  收 ' + (+b.close).toFixed(2) + '</div>'
            + '<div style="font-size:11px">高 ' + (+b.high).toFixed(2) + '  低 ' + (+b.low).toFixed(2) + '  量 ' + (+b.volume).toLocaleString("zh-CN") + '</div>';
        }
      },
      axisPointer: { link: [{ xAxisIndex: "all" }] },
      xAxis: [
        // grid[0] 主图：顶部 x 轴不显示标签（避免与下方量能 x 轴重复）
        { type: "category", data: [], boundaryGap: false, gridIndex: 0, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { show: false }, splitLine: { show: false } },
        // grid[1] 量能：底部 x 轴显示时间标签，margin/padding 压紧不单独占行
        { type: "category", data: [], boundaryGap: false, gridIndex: 1, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: "#aaaaaa", fontSize: 10, fontFamily: "Inter", margin: 0, padding: [0, 0, 0, 0] }, splitLine: { show: false } }
      ],
      yAxis: [
        // grid[0] 主图 y 轴：右侧显示价格刻度 + 浅灰虚线网格 —— min/max 由 _tpIntraData 动态注入（锚定昨收 ±5%，只向外扩不缩）
        { scale: true, gridIndex: 0, position: "right", axisLine: { show: false }, axisLabel: { color: "#aaaaaa", fontSize: 10, fontFamily: "Inter" }, axisTick: { show: false }, splitLine: { lineStyle: { color: "#2a2a2f", type: "dashed" } } },
        // grid[1] 量能 y 轴：右侧隐藏刻度（量能大小不需要数字）
        { scale: true, gridIndex: 1, position: "right", axisLine: { show: false }, axisLabel: { show: false }, axisTick: { show: false }, splitLine: { show: false } }
      ],
      series: [
        // r40j：主图背景层（line 平铺在 maxPrice*1.05 + area 从顶到底覆盖整个 grid[0]，涨跌色淡）——
        //      视觉上让 grid[0] 整片涨跌色铺底，参考中国平安图风格
        { name: "priceBg", type: "line", data: [], xAxisIndex: 0, yAxisIndex: 0,
          showSymbol: false, smooth: false, connectNulls: true,
          lineStyle: { width: 0, color: "transparent" },
          areaStyle: { color: "rgba(54,209,112,0.18)" },   // 默认跌绿（开跌场景），运行时由 _tpIntraData 改色
          z: 0, silent: true },
        // 主图：价格折线 + 涨跌色 area（涨红 #ff4c4c / 跌绿 #36d170）
        { name: "price", type: "line", data: [], xAxisIndex: 0, yAxisIndex: 0,
          showSymbol: false, smooth: false,
          lineStyle: { color: "#36d170", width: 2 },   // 默认跌绿，运行时由 _tpIntraData 改色
          areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: "rgba(54,209,112,0.55)" },
            { offset: 1, color: "rgba(54,209,112,0.02)" }
          ]) },
          z: 3 },
        // 主图：均价线（金黄平滑）—— 保留参考图的橙色均价
        { name: "avg", type: "line", data: [], xAxisIndex: 0, yAxisIndex: 0, showSymbol: false, smooth: true,
          lineStyle: { color: "#ffc120", width: 1.8 }, z: 2 },
        // 量能背景层（line 平铺在 maxVol + area 从顶到底覆盖整个 gr[1]，涨跌色淡）
        { name: "volBg", type: "line", data: [], xAxisIndex: 1, yAxisIndex: 1,
          showSymbol: false, smooth: false, connectNulls: true,
          lineStyle: { width: 0, color: "transparent" },
          areaStyle: { color: "rgba(54,209,112,0.22)" },   // 默认跌绿，运行时改色
          z: 0, silent: true },
        // 量能柱（涨红跌绿）—— grid[1] 在底部
        { name: "vol", type: "bar", data: [], xAxisIndex: 1, yAxisIndex: 1, barWidth: "80%", barCategoryGap: "20%" }
      ]
    };
  }

  let _tpLastAvg2 = [];
  function _tpIntraData(bars) {
    _tpLastBars = bars; _tpLastAvg2 = _calcAvgPrice(bars);
    _tpLastAvg = _tpLastAvg2;   // 双别名，避免与下方 _tpLastAvg 冲突
    const cats = bars.map(b => { const d = b.date || ""; return d.length > 10 ? d.substring(11, 16) : d; });
    const closes = bars.map(b => +b.close);
    const vols = bars.map(b => +b.volume || 0);
    const maxVol = Math.max(1, ...vols);
    // r40j：priceBg 平铺在 maxPrice*1.05，让 area 从顶到底覆盖整个 grid[0]
    const maxPrice = Math.max(...closes, 0) * 1.05 || 1;
    const refPrice = bars[0] ? +bars[0].open : (closes[0] || 0);
    const lastIdx = bars.length - 1;
    const lastPrice = closes[lastIdx] || 0;
    const chgPct = refPrice ? ((lastPrice - refPrice) / refPrice * 100) : 0;
    const isUp = lastPrice >= refPrice;
    // r40j：涨跌色统一（涨红 #ff4c4c / 跌绿 #36d170）—— 折线/area/量能背景/价格背景全用同一个色系
    const chgColor = isUp ? "#ff4c4c" : "#36d170";
    const chgRgb = isUp ? "255,76,76" : "54,209,112";
    const chgStr = (chgPct >= 0 ? "+" : "") + chgPct.toFixed(2) + "%";
    const volData = bars.map(b => ({ value: +b.volume || 0,
      itemStyle: { color: (+b.close >= +b.open) ? "#ff4c4c" : "#36d170" } }));

    // r40k：y 轴范围锚定到昨收 ±5%，只向外扩不缩 → 5 秒刷新时 y 轴范围稳定，画面不"变大变小"
    const halfRange = refPrice * 0.05;
    let minY = refPrice - halfRange;
    let maxY = refPrice + halfRange;
    const dataMin = Math.min(...closes);
    const dataMax = Math.max(...closes);
    // 真突破 ±5% 时才向外扩，且只扩不缩
    if (dataMax > maxY) maxY = dataMax * 1.005;
    if (dataMin < minY) minY = dataMin * 0.995;

    return {
      xAxis: [{ data: cats }, { data: cats }],
      yAxis: [{ min: minY, max: maxY }, {}],   // yAxis[1] 量能不设范围
      series: [
        // priceBg：涨跌色浅，平铺在 y 轴顶部（maxY），area 从顶到底覆盖 grid[0]
        { name: "priceBg", data: bars.map(() => maxY),
          areaStyle: { color: "rgba(" + chgRgb + ",0.18)" } },
        // price：涨跌色折线 + 涨跌色 area 渐变
        { name: "price", data: closes,
          lineStyle: { color: chgColor },
          areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: "rgba(" + chgRgb + ",0.55)" },
            { offset: 1, color: "rgba(" + chgRgb + ",0.02)" }
          ]) }
        },
        { name: "avg", data: _tpLastAvg },
        // volBg：涨跌色浅，平铺 maxVol，area 覆盖 gr[1]
        { name: "volBg", data: bars.map(() => maxVol),
          areaStyle: { color: "rgba(" + chgRgb + ",0.22)" } },
        { name: "vol", data: volData }
      ]
    };
  }

  // 兼容旧调用：buildIntradayOption(bars) = layout + data 合并（仅用于首次/跨模式完整重绘）
  function buildIntradayOption(bars, indicators) {
    const layout = _tpIntraLayout();
    const data = _tpIntraData(bars);
    // merge：data.xAxis/data.series 覆盖 layout.xAxis/layout.series 的 data 字段
    layout.xAxis[0].data = data.xAxis[0].data;
    layout.xAxis[1].data = data.xAxis[1].data;
    layout.series[0].data = data.series[0].data;
    layout.series[0].markPoint = data.series[0].markPoint;
    layout.series[0].markLine = data.series[0].markLine;
    layout.series[1].data = data.series[1].data;
    layout.series[2].data = data.series[2].data;
    layout.series[3].data = data.series[3].data;
    return layout;
  }
  // ---- 模式2【日K+指标】candlestick（无 areaStyle）+ MA5金/MA10蓝/MA20灰 + 量能随涨跌 ----
  function buildDailyOption(bars, indicators) {
    const cats = bars.map(b => b.date);
    const ohlc = bars.map(b => [+b.open, +b.close, +b.low, +b.high]);
    const closes = bars.map(b => +b.close);
    const ma5 = (indicators && indicators.ma5) ? indicators.ma5 : smaArr(closes, 5);
    const ma10 = (indicators && indicators.ma10) ? indicators.ma10 : smaArr(closes, 10);
    const ma20 = (indicators && indicators.ma20) ? indicators.ma20 : smaArr(closes, 20);
    const volData = bars.map(b => {
      const up = +b.close >= +b.open;
      return { value: +b.volume, itemStyle: { color: up ? "#ff4c4c" : "#36d170" } };
    });
    const tipColor = (b) => (+b.close >= +b.open) ? "#ff4c4c" : "#36d170";
    const g = (arr, i) => (arr && arr[i] != null) ? (+arr[i]).toFixed(2) : "--";
    return {
      backgroundColor: "#121214", animation: false,
      textStyle: { fontFamily: "Inter, sans-serif", color: "#aaaaaa" },
      grid: [{ left: 52, right: 14, top: 14, height: "66%" }, { left: 52, right: 14, top: "76%", height: "18%" }],
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "cross", lineStyle: { color: "#5a5a60", type: "dashed" } },
        backgroundColor: "rgba(15,15,15,0.95)", borderColor: "#444", textStyle: { color: "#e5e7eb", fontSize: 11 },
        formatter: function (ps) {
          const i = ps[0].dataIndex, b = bars[i], col = tipColor(b);
          return '<div style="font-size:11px"><b style="color:#f3f4f6">' + b.date + '</b></div>'
            + '<div style="font-size:11px">开 ' + (+b.open).toFixed(2) + ' 收 <b style="color:' + col + '">' + (+b.close).toFixed(2) + '</b></div>'
            + '<div style="font-size:11px">高 ' + (+b.high).toFixed(2) + ' 低 ' + (+b.low).toFixed(2) + '</div>'
            + '<div style="font-size:11px">量 ' + (+b.volume).toLocaleString("zh-CN") + '</div>'
            + '<div style="font-size:11px;color:#d1d5db">MA5 ' + g(ma5, i) + ' · MA10 ' + g(ma10, i) + ' · MA20 ' + g(ma20, i) + '</div>';
        }
      },
      axisPointer: { link: [{ xAxisIndex: "all" }] },
      xAxis: [
        { type: "category", data: cats, boundaryGap: true, gridIndex: 0, axisLine: { lineStyle: { color: "#3a3a3f" } }, axisLabel: { color: "#aaaaaa", fontSize: 10, interval: Math.floor(cats.length / 6) }, axisTick: { show: false }, splitLine: { show: false } },
        { type: "category", data: cats, boundaryGap: true, gridIndex: 1, axisLine: { lineStyle: { color: "#3a3a3f" } }, axisLabel: { show: false }, axisTick: { show: false }, splitLine: { show: false } }
      ],
      yAxis: [
        { scale: true, gridIndex: 0, position: "right", axisLine: { show: false }, axisLabel: { color: "#aaaaaa", fontSize: 10 }, axisTick: { show: false }, splitLine: { lineStyle: { color: "#2a2a30", type: "dashed" } } },
        { scale: true, gridIndex: 1, position: "right", axisLine: { show: false }, axisLabel: { show: false }, axisTick: { show: false }, splitLine: { show: false } }
      ],
      series: [
        { name: "K", type: "candlestick", data: ohlc, xAxisIndex: 0, yAxisIndex: 0,
          itemStyle: { color: "#ff4c4c", color0: "#36d170", borderColor: "#ff4c4c", borderColor0: "#36d170" } },
        { name: "MA5", type: "line", data: ma5, xAxisIndex: 0, yAxisIndex: 0, showSymbol: false, smooth: true, lineStyle: { color: "#ffc120", width: 1.6 } },
        { name: "MA10", type: "line", data: ma10, xAxisIndex: 0, yAxisIndex: 0, showSymbol: false, smooth: true, lineStyle: { color: "#3488eb", width: 1.6 } },
        { name: "MA20", type: "line", data: ma20, xAxisIndex: 0, yAxisIndex: 0, showSymbol: false, smooth: true, lineStyle: { color: "#aaaaaa", width: 1.6 } },
        { name: "vol", type: "bar", data: volData, xAxisIndex: 1, yAxisIndex: 1 }
      ]
    };
  }

  function _normCodeForTp(code) { return (code || "").toLowerCase(); }

  // r29：已用 _renderTradePlan + _drawTpChart，旧的 stockDetailHtml 不再使用（保留函数名以防旧引用报错）。
  function stockDetailHtml(sig, rt, name, code) { return ""; }

  async function loadKline() {
    // K线图已被用户移除，所有调用安全跳过（保留函数名兼容旧引用）
    return;
    // 实时 + 信号
    const rt = await api("GET", "/api/quotes?codes=" + code);
    if (rt[code]) {
      const q = rt[code];
      $("#curPrice").textContent = fmt(q.price);
      $("#curPrice").className = "cur-price " + chgClass(q.change);
      $("#curChange").textContent = `${q.change >= 0 ? "+" : ""}${fmt(q.change)}　${q.change_pct >= 0 ? "+" : ""}${fmt(q.change_pct)}%`;
      $("#curChange").className = "cur-change " + chgClass(q.change);
    }
    await recomputeAdvice();
  }

  async function recomputeAdvice() {
    if (!state.current.code) return;
    const { code, period } = state.current;
    const cap = $("#capInput").value || 100000;
    const hold = $("#holdInput").value || 0;
    const sig = await api("GET", "/api/signal?code=" + code + "&period=" + period + "&limit=120"
      + "&capital=" + cap + "&current_shares=" + hold);
    renderSignal(sig);
  }

  function renderSignal(a, isLive) {
    const body = $("#signalBody");
    if (!a.ok) { body.innerHTML = `<div class="signal-empty">${a.msg || "无法计算信号"}</div>`; $("#adviceBody").innerHTML = ""; return; }
    // 实时模式下，信号从无→买入/卖出时弹提醒
    if (isLive && a.action) {
      const prev = state.lastAction;
      if (prev && prev !== a.action && (a.action.includes("买入") || a.action.includes("卖出")))
        toast("⚡ 信号变化：" + (state.current.name || state.current.code) + " → " + a.action);
      state.lastAction = a.action;
    }
    const color = ACT_COLOR[a.action] || "#868e96";
    const knob = (a.score + 100) / 2;
    const reasons = a.reasons.map(r => {
      const pc = r.pts > 0 ? "pos" : r.pts < 0 ? "neg" : "";
      return `<li><span class="pts ${pc}">${r.pts > 0 ? "+" : ""}${r.pts}</span>${r.text}</li>`;
    }).join("");
    const ind = a.indicators;
    const kv = (k, v) => `<div class="kv"><div class="k">${k}</div><div class="v">${v}</div></div>`;
    body.innerHTML = `
      <div class="signal-head">
        <span class="action-badge" style="background:${color}">${a.action}</span>
        <span style="font-size:12px;color:var(--muted)">综合评分</span>
        <div class="score-bar"><div class="score-knob" style="left:${knob}%"></div></div>
        <b style="font-variant-numeric:tabular-nums">${a.score}</b>
      </div>
      <ul class="reasons">${reasons}</ul>
      <div class="kv-grid">
        ${kv("MA5", fmt(ind.ma.ma5))} ${kv("MA10", fmt(ind.ma.ma10))} ${kv("MA20", fmt(ind.ma.ma20))} ${kv("MA60", fmt(ind.ma.ma60))}
        ${kv("MACD", `${fmt(ind.macd.dif)}/${fmt(ind.macd.dea)}`)} ${kv("KDJ", `${fmt(ind.kdj.k, 1)}/${fmt(ind.kdj.d, 1)}`)} ${kv("RSI12", fmt(ind.rsi.rsi12, 1))} ${kv("BOLL", `${fmt(ind.boll.lower)}~${fmt(ind.boll.upper)}`)}
      </div>`;
    renderAdvice(a.position, a.price, a.today);
  }

  function renderAdvice(pos, price, today) {
    const el = $("#adviceBody");
    if (!pos) { el.innerHTML = ""; return; }
    const cls = pos.action.includes("买入") ? "adv-buy" : pos.action.includes("卖出") ? "adv-sell" : "adv-hold";
    const pctTxt = (pos.target_pct * 100).toFixed(1) + "%";
    const deltaTxt = pos.delta_shares > 0 ? `买 ${pos.delta_shares} 股`
      : pos.delta_shares < 0 ? `卖 ${-pos.delta_shares} 股` : "不动";
    const rg = state.watchMeta[state.current.code] ? state.watchMeta[state.current.code].regime : null;
    const adp = state.watchMeta[state.current.code] ? state.watchMeta[state.current.code].adaptive : null;
    let regimeHtml = "";
    if (rg) {
      const trend = rg.trend_pct, fund = rg.fund_net;
      const weak = (trend != null && trend < 0) && (fund != null && fund < 0);
      const fundTxt = fund == null ? "资金未知" : (fund >= 0 ? `资金流入 +${fmt(fund)}亿` : `资金流出 ${fmt(fund)}亿`);
      const trendTxt = trend == null ? "板块未知" : `板块 ${trend >= 0 ? "+" : ""}${fmt(trend)}%`;
      regimeHtml = `<div class="advice-note" style="background:#f1f3f5;border-color:#dee2e6;color:#495057">🧭 ${rg.track || rg.sector || "板块"}：${trendTxt}　${fundTxt}${weak ? "　⚠️弱势先减仓" : ""}</div>`;
    }
    let todayHtml = "";
    if (adp && adp.bias === "defensive") {
      todayHtml = `<div class="advice-note" style="background:#fff5f5;border-color:#ffc9c9;color:#c92a2a">⚠️ 板块弱势·资金流出：${adp.tip}${adp.limit_down != null ? `（跌停约 ${fmt(adp.limit_down)} 才低吸买回）` : ""}</div>`;
    } else if (today && today.buy != null) {
      todayHtml = `<div class="advice-note" style="background:#f8f9fa;border-color:#dee2e6;color:#495057">📅 今日做T参考：涨到 <b style="color:#c92a2a">${fmt(today.sell)}</b> 卖 / 跌到 <b style="color:#2b8a3e">${fmt(today.buy)}</b> 买（开盘 ${fmt(today.open)}）</div>`;
    }
    const o = state.watchMeta[state.current.code] ? state.watchMeta[state.current.code].outlook : null;
    let outlookHtml = "";
    if (o) {
      const tColor = o.trend === "偏多" ? "#2b8a3e" : o.trend === "偏空" ? "#c92a2a" : "#868e96";
      const aColor = o.action === "买" ? "#2b8a3e" : o.action === "卖" ? "#c92a2a" : "#868e96";
      const aBg = o.action === "买" ? "#e6fcf5" : o.action === "卖" ? "#fff5f5" : "#f1f3f5";
      const aTxt = o.action === "买" ? "👉 现在可买" : o.action === "卖" ? "👉 现在可卖" : "⏸ 先不动";
      const pts = (o.tech_points || []).slice(0, 4).map(t => `<li style="font-size:10.5px;color:#495057">· ${t}</li>`).join("");
      outlookHtml = `<div style="margin-top:6px;padding:7px 9px;background:${aBg};border:1px solid ${aColor}66;border-radius:6px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:12px;font-weight:700;color:${tColor}">📊 今日研判：${o.trend}</span>
          <span style="font-size:14px;font-weight:800;color:#fff;background:${aColor};padding:3px 12px;border-radius:12px">${aTxt}</span>
        </div>
        <div style="font-size:11px;color:#495057;margin-top:4px;line-height:1.6">${o.reason}</div>
        ${pts ? `<ul style="margin:4px 0 0;padding-left:15px">${pts}</ul>` : ""}
      </div>`;
    }
    el.innerHTML = `
      <div class="advice-card ${cls}">
        <div class="advice-title">操作建议 · <b>${pos.action}</b></div>
        <div class="advice-held">当前持仓：${pos.current_shares} 股</div>
        <div class="advice-grid">
          <div><span>目标仓位</span><b>${pctTxt}</b></div>
          <div><span>目标股数</span><b>${pos.target_shares} 股</b></div>
          <div><span>本次操作</span><b>${deltaTxt}</b></div>
          <div><span>涉及金额</span><b>¥${Math.abs(pos.delta_cash).toLocaleString("zh-CN", {maximumFractionDigits:0})}</b></div>
        </div>
        <div class="advice-text">${pos.suggestion}</div>
        ${pos.note ? `<div class="advice-note">⚠️ ${pos.note}</div>` : ""}
        ${regimeHtml}
        ${todayHtml}
        ${outlookHtml}
      </div>`;
  }

  // ---------- 选股 ----------
  // 已在自选的股把「+自选」置灰为「已添加」，避免误点又弹「已在自选」
  function _watchBtn(r) {
    if (_inWatch(r.code)) {
      return `<button class="scan-add added" disabled data-code="${r.code}">已添加</button>`;
    }
    return `<button class="scan-add" data-code="${r.code}" data-name="${r.name || r.code}" data-price="${r.price != null ? r.price : ''}" data-buy="${r.buy_price != null ? r.buy_price : ''}">+自选</button>`;
  }
  function renderScanRows(results, limit) {
    const rows = (results || []).slice(0, limit || 200).map(r => {
      const c = ACT_COLOR[r.action] || "#868e96";
      const bp = r.buy_price != null ? `<span style="color:#2b8a3e">买 ${fmt(r.buy_price)}</span>` : "";
      const sp = r.sell_price != null ? `<span style="color:#c92a2a">卖 ${fmt(r.sell_price)}</span>` : "";
      const bq = r.buy_qty ? `买量 ${r.buy_qty}股` : "";
      const extra = (bp || sp || bq)
        ? `<div class="sc-extra">${[bp, sp, bq].filter(Boolean).join("　")}</div>` : "";
      return `<div class="scan-row" data-code="${r.code}" data-name="${r.name}">
        <span class="tag" style="background:${c}">${r.action}</span>
        <span class="sc-name">${r.name || r.code}<br><span style="color:var(--muted);font-size:11px">${r.code}</span></span>
        <span class="sc-score ${chgClass(r.score)}">${r.score > 0 ? "+" : ""}${r.score}</span>
        ${extra}
        ${_watchBtn(r)}
      </div>`;
    }).join("");
    return rows;
  }
  function bindScanRows(el) {
    el.querySelectorAll(".scan-row").forEach(row =>
      row.addEventListener("click", (e) => {
        if (e.target.classList.contains("scan-add")) return;
        openStock(row.dataset.code, row.dataset.name);
      }));
    el.querySelectorAll(".scan-add").forEach(btn =>
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        addToWatch(btn.dataset.code, btn.dataset.name,
                   btn.dataset.price || null, btn.dataset.buy || null);
      }));
  }

  // 候选股（十五五成长池）富表渲染
  function renderCandidateRows(results) {
    return (results || []).map(r => {
      const c = ACT_COLOR[r.action] || "#868e96";
      const gradeColor = { A: "#c92a2a", B: "#1971c2", C: "#868e96" }[r.fund_grade] || "#868e96";
      const peTxt = r.pe != null ? `<span style="color:#666">PE <b>${r.pe}</b></span>` : "";
      const tgtTxt = r.target != null
        ? `<span style="color:#1971c2">机构目标 <b>${fmt(r.target)}</b>${r.target_upside != null ? ` <span style="color:${r.target_upside >= 0 ? '#2b8a3e' : '#c92a2a'}">${r.target_upside >= 0 ? '+' : ''}${(r.target_upside * 100).toFixed(0)}%</span>` : ""}</span>`
        : "";
      const expTxt = r.expect_score != null ? `<span style="color:#666">预期 <b>${r.expect_score}</b></span>` : "";
      let indNewsTxt = "";
      const inw = r.industry_news || {};
      if (inw.status === "ok" && inw.headlines && inw.headlines.length) {
        const sc2 = inw.score || 0;
        const col = sc2 > 0 ? "#c92a2a" : sc2 < 0 ? "#2b8a3e" : "#868e96";
        indNewsTxt = `<span style="color:${col}">行业新闻 ${sc2 > 0 ? "偏多+" : sc2 < 0 ? "偏空" : "中性"}${Math.abs(sc2)}</span>`;
      }
      return `<div class="cand-row" data-code="${r.code}" data-name="${r.name}" style="padding:8px 4px;border-bottom:1px solid #eee;cursor:pointer">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span class="tag" style="background:${c}">${r.action}</span>
          <span style="font-weight:600">${r.name}</span><span style="color:#888;font-size:11px">${r.code}</span>
          <span style="color:#666;font-size:12px">· ${r.track}</span>
          <span style="color:#666;font-size:12px">· 赛道 ${r.sector_trend != null ? (r.sector_trend >= 0 ? "↑" : "↓") + fmt(r.sector_trend) + "%" : "—"}${r.sector_fund != null ? "　主力" + (r.sector_fund >= 0 ? "+" : "") + r.sector_fund.toFixed(1) + "亿" : ""}</span>
          <span style="margin-left:auto;font-size:12px">综合 <b style="font-size:14px">${r.combined}</b> <span style="color:#999">（技${r.tech_score}/行${r.sector_score}/估${r.val_score}/动${r.mom_score}）</span></span>
          ${_watchBtn(r)}
        </div>
        <div style="display:flex;align-items:center;gap:14px;margin-top:5px;font-size:12px;flex-wrap:wrap">
          <span>现价 <b>${fmt(r.price)}</b></span>
          <span style="color:#c92a2a">买价 <b>${fmt(r.buy_price)}</b></span>
          <span style="color:#2b8a3e">卖价 <b>${fmt(r.sell_price)}</b></span>
          <span>买量 <b>${r.buy_qty}股</b></span>
          ${r.ma5 != null && r.ma20 != null ? `<span style="color:#666">MA5 <b>${fmt(r.ma5)}</b> / MA20 <b>${fmt(r.ma20)}</b>${r.vs_ma20_pct != null ? `　<span style="color:${r.vs_ma20_pct >= 0 ? '#2b8a3e' : '#c92a2a'}">vsMA20 ${r.vs_ma20_pct >= 0 ? '+' : ''}${r.vs_ma20_pct}%</span>` : ""}</span>` : ""}
          <span style="color:${gradeColor}">基本面 ${r.fund_grade}</span>
        </div>
        <div style="display:flex;align-items:center;gap:14px;margin-top:3px;font-size:12px;flex-wrap:wrap">
          ${peTxt} ${tgtTxt} ${expTxt} ${indNewsTxt}
        </div>
        ${r.trend_hint && r.trend_hint !== "中性" ? `<div style="margin-top:3px;font-size:11px;color:#1971c2">📈 ${r.trend_hint}</div>` : ""}
        ${r.note ? `<div style="margin-top:4px;font-size:12px;color:#555">💡 ${r.note}</div>` : ""}
        ${r.reasons && r.reasons.length ? `<div style="margin-top:2px;font-size:11px;color:#999">${r.reasons.join("；")}</div>` : ""}
      </div>`;
    }).join("");
  }
  function bindCandidateRows(el) {
    el.querySelectorAll(".cand-row").forEach(row =>
      row.addEventListener("click", (e) => {
        if (e.target.classList.contains("scan-add")) return;
        openStock(row.dataset.code, row.dataset.name);
      }));
    el.querySelectorAll(".scan-add").forEach(btn =>
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        addToWatch(btn.dataset.code, btn.dataset.name,
                   btn.dataset.price || null, btn.dataset.buy || null);
      }));
  }

  // 全局搜索 / 局部搜索点击：加入自选
  async function addToWatchFromSearch(code, name) {
    await addToWatch(code, name, null, null);
  }

  // 扫描结果「加自选」：记录添加时间/添加时价格/推荐买价
  // 扫描结果「加自选」：记录添加时间/添加时价格/推荐买价
  async function addToWatch(code, name, price, buy) {
    if (_inWatch(code)) { toast("已在自选：" + (name || code)); return; }
    const item = {
      code, name: name || code,
      add_time: new Date().toISOString(),
      add_price: price != null && price !== "" ? parseFloat(price) : null,
      scan_buy: buy != null && buy !== "" ? parseFloat(buy) : null,
    };
    state.watchlist.push(item);
    renderWatchlist();   // 乐观渲染：先让用户立刻看到，不被保存请求阻塞
    try {
      const r = await saveWatchlist();
      if (r && r.items) state.watchlist = r.items;  // 以服务端为准，避免重复/错位
    } catch (e) {
      toast("已加入本地自选（云端保存失败，下次刷新会重试）");
    }
    await computeSignals();
    toast("已加入自选：" + (name || code));
  }

  async function runScreener() {
    const scope = $("#scopeSelect").value;
    const strategy = $("#strategySelect").value;
    const el = $("#screenerResults");
    if (scope === "online_all") {
      // 全市场走后台异步扫描，前端轮询进度
      el.innerHTML = `<div class="scan-progress"><div class="bar"><i id="scanBar"></i></div>
        <div class="sub" id="scanMsg">正在生成全市场股票池并扫描…（首次约 1–2 分钟，之后走缓存很快）</div></div>`;
      await api("GET", "/api/screener?scope=online_all&strategy=" + strategy + "&limit=120");
      pollScan(strategy);
      return;
    }
    if (scope === "candidate") {
      const cap = 100000;
      el.innerHTML = `<div class="scan-progress"><div class="bar"><i id="scanBar"></i></div>
        <div class="sub" id="scanMsg">正在扫描十五五成长池（纯主板，约 1 分钟：拉行情→算技术面+基本面+赛道趋势）…</div></div>`;
      await api("GET", "/api/screener?scope=candidate&strategy=" + strategy + "&limit=120&capital=" + cap);
      pollScan(strategy);
      return;
    }
    el.innerHTML = `<div class="signal-empty">扫描中…</div>`;
    const data = await api("GET", "/api/screener?scope=" + scope + "&strategy=" + strategy + "&limit=120");
    if (!data.results.length) {
      el.innerHTML = `<div class="signal-empty">${data.count ? "无符合「" + (data.strategy_label || strategy) + "」的标的" : "该范围暂无股票（自选为空 / 未配置通达信 / universe.txt 为空）"}</div>`;
      return;
    }
    el.innerHTML = '<div class="scan-hint">策略：' + (data.strategy_label||"") + ' · <b style="color:#2b8a3e">命中 ' + data.results.length + ' 只</b>（按购买优先级排序：买入在前，卖出在后）</div>' + renderScanRows(_filterByRange(data.results));
    bindScanRows(el);
  }

  // 涨幅区间前端过滤（P4）：根据勾选筛选
  function _filterByRange(results) {
    if (!Array.isArray(results)) return results || [];
    const r1 = document.getElementById("sfRng1");
    const r2 = document.getElementById("sfRng2");
    const r3 = document.getElementById("sfRng3");
    const summary = document.getElementById("sfSummary");
    const on = [(r1 && r1.checked), (r2 && r2.checked), (r3 && r3.checked)];
    const keep = (pct) => {
      if (pct == null) return on[1] || on[2];
      if (pct <= 3) return on[0];
      if (pct <= 8) return on[1];
      return on[2];
    };
    const out = results.filter(r => keep(r.change_pct != null ? r.change_pct : null));
    // 按"购买优先级"重新排序：买入 > 持有 > 卖出；同档按综合分降序
    const actionRank = { '强烈买入':0, '买入':0, '加仓':0, '持有':1, '持有观察':1, '减仓':2, '卖出':2 };
    out.sort((a, b) => {
      const ra = actionRank[a.action] != null ? actionRank[a.action] : 1;
      const rb = actionRank[b.action] != null ? actionRank[b.action] : 1;
      if (ra !== rb) return ra - rb;
      const sa = a.combined != null ? a.combined : (a.score != null ? a.score : 0);
      const sb = b.combined != null ? b.combined : (b.score != null ? b.score : 0);
      return sb - sa;
    });
    if (summary) summary.textContent = '命中 ' + out.length + '/' + results.length + ' 只（按购买优先级排序：买入在前，卖出在后）';
    return out;
  }

  async function pollScan(strategy) {
    const el = $("#screenerResults");
    try {
      const st = await api("GET", "/api/scan_status");
      const total = st.total || 1;
      const pct = Math.min(100, Math.round((st.done / total) * 100));
      const isCand = st.scope === "candidate";
      // 涨幅区间筛选（P4）：仅作用于候选池和全市场扫描
      const filtered = isCand || st.scope === "online_all" ? _filterByRange(st.results) : (st.results || []);
      const rows = isCand ? renderCandidateRows(filtered) : renderScanRows(filtered);
      const hint = st.results.length
        ? (isCand
            ? '<div class="scan-hint">十五五成长池（纯主板 ' + st.total + ' 只）· 命中 <b style="color:#2b8a3e">' + st.results.length + '</b> 只（按购买优先级排序：买入在前，卖出在后）</div>'
            : '<div class="scan-hint">策略：' + strategy + ' · 已命中 <b style="color:#2b8a3e">' + st.results.length + '</b> 只（实时更新）</div>')
        : "";
      el.innerHTML = `<div class="scan-progress"><div class="bar"><i id="scanBar" style="width:${pct}%"></i></div>
        <div class="sub">已扫描 ${st.done}/${st.total} 只，命中 ${st.results.length} 只…</div></div>${hint}${rows}`;
      if (isCand) bindCandidateRows(el); else bindScanRows(el);
      if (st.running) {
        setTimeout(() => pollScan(strategy), 1500);
      } else if (st.error) {
        toast("扫描出错：" + st.error);
      } else if (!st.results.length) {
        el.innerHTML = isCand
          ? `<div class="signal-empty">成长池暂无符合「${strategy}」的标的（可换策略或等盘中变化）</div>`
          : `<div class="signal-empty">全市场暂无符合「${strategy}」的标的（可换策略或等盘中变化）</div>`;
      }
    } catch (e) {
      toast("扫描状态获取失败");
    }
  }

  async function rebuildUniverse() {
    const btn = $("#rebuildBtn");
    btn.disabled = true; btn.textContent = "生成中…";
    try {
      const r = await api("GET", "/api/build_universe");
      toast(r.ok ? `已重建股票池：${r.count} 只` : ("重建失败：" + (r.error || "")));
    } catch (e) {
      toast("重建失败");
    } finally {
      btn.disabled = false; btn.textContent = "重建股票池";
    }
  }

  // ---------- 券商跳转 ----------
  // （已按需求移除「去券商看」跳转；自动研判 + 持仓建议为本工作台核心）

  // ---------- 持仓台账（重写：紧凑型 + 做T + 跳转） ----------
  async function loadPositions() {
    try { state.positions = await api("GET", "/api/positions"); } catch (e) { state.positions = []; }
    // 持仓渲染完全由批量建议驱动（含实时价/行业强弱/操作价量）
    await loadPositionAdvice();
  }
  function tPlanHtml(p, m) {
    // 板块强弱条（资金流+龙头涨跌），小白一眼看懂当天环境
    const rg = m.regime;
    let rgHtml = "";
    if (rg) {
      const trend = rg.trend_pct, fund = rg.fund_net;
      const weak = (trend != null && trend < 0) && (fund != null && fund < 0);
      const rgColor = weak ? "#c92a2a" : (trend != null && trend > 0 ? "#2b8a3e" : "#868e96");
      const fundTxt = fund == null ? "资金未知" : (fund >= 0 ? `资金流入 +${fmt(fund)}亿` : `资金流出 ${fmt(fund)}亿`);
      const trendTxt = trend == null ? "板块未知" : `板块 ${trend >= 0 ? "+" : ""}${fmt(trend)}%`;
      rgHtml = `<div style="margin-top:4px;padding:3px 7px;background:#f1f3f5;border-radius:4px;font-size:10.5px;color:#495057">
        🧭 ${rg.track || rg.sector || "板块"}：${trendTxt}　${fundTxt}${weak ? "　⚠️弱势" : ""}
      </div>`;
    }
    // 1) 弱市：先减仓防跌，跌停才低吸买回做T
    const adp = m.adaptive;
    if (adp && adp.bias === "defensive") {
      const ld = adp.limit_down;
      const price = m.price;
      let status = "⚠️ 板块弱势·资金流出：先减仓防继续跌", statusColor = "#c92a2a";
      if (price != null && ld != null && price <= ld) { status = "✅ 已到跌停区，可低吸买回做T"; statusColor = "#2b8a3e"; }
      return `<div style="margin-top:4px;padding:5px 7px;background:#fff5f5;border-left:3px solid ${statusColor};border-radius:4px;font-size:11px;line-height:1.8">
        <div style="font-weight:700;color:${statusColor}">${status}</div>
        <div>💡 ${adp.tip}</div>
        ${ld != null ? `<div>📉 跌到 <b style="color:#2b8a3e">${fmt(ld)}</b>（约跌停）才低吸买回做T</div>` : ""}
        ${price != null ? `<div style="color:#666;margin-top:2px">现价 ${fmt(price)}</div>` : ""}
      </div>${rgHtml}`;
    }
    // 2) 普通市：不再显示"比开盘 +3% 卖"那种死板的延迟信号；
    //    改为显示「今天趋势+现价结论」+「板块/技术要点」，让用户当下就知道该不该动。
    const price = m.price;
    const o = m.outlook;
    let action = "⏸ 持有观察", actionColor = "#868e96", reason = "盘中，暂无明确多空信号";
    if (o) {
      if (o.trend === "偏多" && price != null && m.today_buy != null && price <= m.today_buy * 1.005) {
        action = "👉 趋势偏多·可低吸买"; actionColor = "#2b8a3e";
        reason = `今天偏多，现价 ${fmt(price)} 已在买点附近`;
      } else if (o.trend === "偏空" && price != null) {
        action = "👉 趋势偏空·先减仓别加仓"; actionColor = "#c92a2a";
        reason = `今天偏空（${o.reason || ""}），建议先卖防继续跌`;
      } else if (o.trend === "偏多" && price != null && m.today_sell != null && price >= m.today_sell * 0.995) {
        action = "👉 趋势偏多·到高抛位可卖"; actionColor = "#2b8a3e";
        reason = `今天偏多，现价 ${fmt(price)} 已近高抛位`;
      } else if (o.action === "买") {
        action = "👉 技术到位可买"; actionColor = "#2b8a3e";
        reason = o.reason || "";
      } else if (o.action === "卖") {
        action = "👉 技术到位可卖"; actionColor = "#c92a2a";
        reason = o.reason || "";
      } else {
        action = `⏸ ${o.trend}·等价格到位`; actionColor = "#868e96";
        reason = o.reason || "等价格走到买卖点";
      }
    }
    // 数据齐全时附上具体买卖点参考 + 现价
    const ref = (m.today_buy != null && m.today_sell != null)
      ? `<div style="color:#666;margin-top:2px">参考买入 <b style="color:#2b8a3e">≤${fmt(m.today_buy)}</b>　参考卖出 <b style="color:#c92a2a">≥${fmt(m.today_sell)}</b>${m.today_open != null ? `　（开盘 ${fmt(m.today_open)}）` : ""}</div>`
      : (m.t_plan ? `<div style="color:#666">${m.t_plan.t_action}${m.t_plan.t_buy_price ? `　吸 ${fmt(m.t_plan.t_buy_price)}` : ""}${m.t_plan.t_sell_price ? `　抛 ${fmt(m.t_plan.t_sell_price)}` : ""}</div>` : "");
    return `<div style="margin-top:4px;padding:5px 7px;background:#f8f9fa;border-left:3px solid ${actionColor};border-radius:4px;font-size:11px;line-height:1.7">
      <div style="font-weight:700;color:${actionColor}">${action}</div>
      <div style="color:#495057">${reason}</div>
      ${ref}
      ${price != null ? `<div style="color:#666;margin-top:2px">现价 ${fmt(price)}</div>` : ""}
    </div>${rgHtml}`;
  }

  // 今日研判卡：技术面+资金流+当日带宽 → 偏多/偏空/震荡 + 当前买/卖/不动（每次刷新重算）
  function renderOutlook(m) {
    const o = m.outlook;
    if (!o) return "";
    const trend = o.trend, action = o.action;
    const trendColor = trend === "偏多" ? "#2b8a3e" : trend === "偏空" ? "#c92a2a" : "#868e96";
    const actColor = action === "买" ? "#2b8a3e" : action === "卖" ? "#c92a2a" : "#868e96";
    const actBg = action === "买" ? "#e6fcf5" : action === "卖" ? "#fff5f5" : "#f1f3f5";
    const actTxt = action === "买" ? "👉 现在可买" : action === "卖" ? "👉 现在可卖" : "⏸ 先不动";
    const points = (o.tech_points || []).slice(0, 4).map(t => `<li style="font-size:10px;color:#495057">· ${t}</li>`).join("");
    return `<div style="margin-top:5px;padding:6px 8px;background:${actBg};border:1px solid ${actColor}55;border-radius:5px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:11px;color:${trendColor};font-weight:700">📊 今日研判：${trend}</span>
        <span style="font-size:13px;font-weight:800;color:#fff;background:${actColor};padding:2px 10px;border-radius:10px">${actTxt}</span>
      </div>
      <div style="font-size:10.5px;color:#495057;margin-top:3px;line-height:1.6">${o.reason}</div>
      ${points ? `<ul style="margin:3px 0 0;padding-left:14px">${points}</ul>` : ""}
    </div>`;
  }

  function renderPositions() {
    const ul = $("#posList");
    const adv = state.posAdvice || [];
    if (!adv.length) { ul.innerHTML = `<li class="pos-empty" style="text-align:center;color:var(--muted);padding:20px;font-size:12px">暂无持仓</li>`; return; }
    ul.innerHTML = adv.map(p => {
      const act = p.action || "不动";
      const actClass = "act-" + act;
      const priceTxt = p.price != null
        ? `<span class="px ${chgClass(p.change_pct)}">${fmt(p.price)}</span><span class="chg ${chgClass(p.change_pct)}" style="font-size:10px;margin-left:3px">${p.change_pct != null ? (p.change_pct >= 0 ? "+" : "") + fmt(p.change_pct) + "%" : ""}</span>`
        : `<span class="px">--</span>`;
      let pl = "";
      if (p.price != null && p.cost > 0 && p.shares > 0) {
        const pct = (p.price / p.cost - 1) * 100;
        pl = `<span class="pl ${pct >= 0 ? "up" : "down"}" style="font-size:10px">${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%</span>`;
      }
      const rg = p.regime;
      let rgTxt = "";
      if (rg) {
        const t = rg.trend_pct, f = rg.fund_net;
        const weak = (t != null && t < 0) && (f != null && f < 0);
        const tTxt = t == null ? "板块?" : `板块 ${t >= 0 ? "+" : ""}${fmt(t)}%`;
        const fTxt = f == null ? "资金未知" : (f >= 0 ? `资金+${fmt(f)}亿` : `资金${fmt(f)}亿`);
        rgTxt = `🧭 ${rg.track || rg.sector || "板块"}：${tTxt}　${fTxt}${weak ? "　⚠️弱势" : ""}`;
      }
      const opPrice = p.op_price != null ? fmt(p.op_price) : "--";
      const opQty = p.op_qty != null ? p.op_qty : 0;
      const badgeTxt = act === "买入" ? "建议买入" : act === "卖出" ? "建议卖出" : "建议不动";
      const basis = p.op_basis ? `📐 价格逻辑：${p.op_basis}` : "";
      // 基本面/预期（PE + 机构目标价 + 新闻，best-effort）
      let factTxt = "";
      const f = p.facts;
      if (f) {
        const pe = f.pe != null ? `PE ${f.pe}` : "";
        const tgt = f.target != null
          ? `机构目标 ${fmt(f.target)}${f.target_upside != null ? ` <span style="color:${f.target_upside >= 0 ? '#2b8a3e' : '#c92a2a'}">${f.target_upside >= 0 ? '+' : ''}${(f.target_upside * 100).toFixed(0)}%</span>` : ""}` : "";
        factTxt = [pe, tgt].filter(Boolean).join("　");
      }
      return `<li class="pos-item" data-code="${p.code}">
        <div class="pos-row1">
          <span class="pos-name">${p.name || p.code}</span>
          ${priceTxt}
          ${pl}
        </div>
        <div class="pos-row2">
          <span class="pos-edit">
            成本<input class="pos-cost input xs" type="number" value="${p.cost || 0}">
            股数<input class="pos-shares input xs" type="number" value="${p.shares || 0}">
            <button class="pos-btn save" data-act="save" data-code="${p.code}">存</button>
          </span>
          <button class="pos-btn del" data-act="del" data-code="${p.code}">✕</button>
        </div>
        <div class="pos-advice ${actClass}">
          <div class="pa-head">
            <span class="pa-badge ${actClass}">${badgeTxt}</span>
            <span class="pa-line">操作价 <b>${opPrice}</b></span>
            <span class="pa-line">操作量 <b>${opQty}股</b></span>
          </div>
          ${basis ? `<div class="pa-basis">${basis}</div>` : ""}
          ${factTxt ? `<div class="pa-fact">📊 ${factTxt}</div>` : ""}
          ${rgTxt ? `<div class="pa-regime">${rgTxt}</div>` : ""}
          ${p.reason ? `<div class="pa-reason">${p.reason}</div>` : ""}
          <div class="pa-intraday" data-code="${p.code}">⏳ 分时建议加载中…</div>
        </div>
      </li>`;
    }).join("");
    ul.querySelectorAll(".pos-btn[data-act='del']").forEach(el => el.addEventListener("click", async (e) => {
      e.stopPropagation();
      const code = el.dataset.code;
      await api("DELETE", "/api/positions?code=" + code);
      toast("已移除：" + code + "（云端主源已同步，下次推送后 Render 生效）");
      await loadPositions();
    }));
    ul.querySelectorAll(".pos-btn[data-act='save']").forEach(el => el.addEventListener("click", async (e) => {
      e.stopPropagation();
      const li = el.closest(".pos-item");
      const cost = parseFloat(li.querySelector(".pos-cost").value || "0") || 0;
      const shares = parseInt(li.querySelector(".pos-shares").value || "0", 10) || 0;
      const code = el.dataset.code;
      const name = (state.posAdvice.find(x => x.code === code) || {}).name || code;
      await api("POST", "/api/positions", { code, name, shares, cost });
      toast(`已存：${name} ${shares}股×¥${cost}（已同步云端主源）`);
      await loadPositions();
    }));
    ul.querySelectorAll(".pos-item").forEach(el => el.addEventListener("click", (e) => {
      if (e.target.closest(".pos-edit") || e.target.closest(".pos-btn")) return;
      const code = el.dataset.code;
      const m = (state.posAdvice || []).find(x => x.code === code) || {};
      openStock(code, m.name || code);
    }));
  }


  // ---------- 评分权重 ----------
  function setupWeights(cfg) {
    const cats = cfg.weight_categories || {};
    const mult = cfg.weight_multipliers || {};
    const box = $("#weightSliders");
    box.innerHTML = Object.keys(cats).map(cat => {
      const v = mult[cat] != null ? mult[cat] : 1.0;
      return `<div class="weight-row"><label>${cat}</label>
        <input type="range" min="0" max="2" step="0.1" value="${v}" data-cat="${cat}">
        <span class="wval" id="wv_${cat}">${Number(v).toFixed(1)}x</span></div>`;
    }).join("");
    box.querySelectorAll("input[type=range]").forEach(inp =>
      inp.addEventListener("input", () => { $("#wv_" + inp.dataset.cat).textContent = parseFloat(inp.value).toFixed(1) + "x"; }));
  }
  async function saveWeights() {
    const mult = {};
    document.querySelectorAll("#weightSliders input[type=range]").forEach(inp => { mult[inp.dataset.cat] = parseFloat(inp.value); });
    await api("POST", "/api/config", { weight_multipliers: mult });
    toast("权重已保存，下次计算生效");
  }
  async function resetWeights() {
    document.querySelectorAll("#weightSliders input[type=range]").forEach(inp => { inp.value = 1.0; $("#wv_" + inp.dataset.cat).textContent = "1.0x"; });
    await saveWeights();
  }

  // ---------- 定时器 ----------
  function startMonitor() { state.timers.push(setInterval(pollQuotes, 5000)); }
  function startAlertCheck() { state.timers.push(setInterval(checkAlerts, 6000)); loadAlerts(); }
  // 旧 loadPositionAdvice / renderPositions 已被 renderAccount/renderPosTable 取代，保留空函数避免旧调用报错
  async function loadPositionAdvice() { return renderAccount(); }
  // 旧函数已被 renderAccount / renderPosTable / renderAiAdvice 取代，保留空壳避免旧调用报错
  function renderPositions() { /* 已迁移到 renderPosTable */ }
  function renderInlineIntraday() { /* 盘中即时建议面板已合并到 AI 建议卡 */ }
  async function pollIntraday() { /* 盘中面板已折叠到 AI 建议卡 */ }
  function renderIntradayList() { /* 同上 */ }
  // 尾盘策略汇总：每天 14:30-15:00 给出"减仓哪几只 / 埋伏哪 1 只"结论
  async function loadTailStrategy() {
    try {
      const data = await api("GET", "/api/tail_market_strategy");
      if (!data) return;
      renderTailStrategy(data);
    } catch (e) { /* ignore */ }
  }
  function renderTailStrategy(d) {
    const phaseEl = document.getElementById("tailPhase");
    if (phaseEl) phaseEl.textContent = d.phase || "";
    const concl = document.getElementById("tailConclusion");
    if (concl) concl.textContent = d.conclusion || "—";
    const red = document.getElementById("tailReduce");
    if (red) {
      if (!d.reduce_list || !d.reduce_list.length) {
        red.innerHTML = '<li class="sub" style="color:var(--muted)">暂无（持仓均持有观察）</li>';
      } else {
        red.innerHTML = d.reduce_list.map(r => _tailRow(r, true)).join("");
      }
    }
    const bury = document.getElementById("tailBury");
    if (bury) {
      if (!d.buries || !d.buries.length) {
        bury.innerHTML = '<li class="sub" style="color:var(--muted)">暂无低位埋伏标的</li>';
      } else {
        bury.innerHTML = d.buries.map(b => _tailRow(b, false)).join("");
      }
    }
  }
  function _tailRow(r, isReduce) {
    const color = r.action_color || (isReduce ? "#c92a2a" : "#2b8a3e");
    const pct = r.now_pct != null
      ? `<b style="color:${r.now_pct >= 0 ? '#c92a2a' : '#2b8a3e'}">${r.now_pct >= 0 ? '+' : ''}${r.now_pct}%</b>` : "";
    const tag = `<span style="display:inline-block;padding:1px 6px;border-radius:5px;background:${color}1a;color:${color};font-weight:600">${r.action || (isReduce ? '减仓' : '可埋伏')}</span>`;
    return `<li class="tail-item">
      <span class="tail-name">${r.name || r.code}</span>
      ${pct}
      ${tag}
      ${r.reason ? `<span class="tail-reason">${r.reason}</span>` : ""}
    </li>`;
  }

  function _intradayRowHtml(row) {
    const it = row.it;
    if (!it) {
      return `<li class="intraday-row" data-code="${row.code}">
        <span class="it-name">${row.name}</span><span class="sub it-wait">分析中…</span>
      </li>`;
    }
    const isErr = it.error || it.scenario === "数据不足";
    if (isErr && it.error) {
      return `<li class="intraday-row" data-code="${row.code}">
        <span class="it-name">${row.name}</span>
        <span class="sub" style="color:var(--muted)">${it.scenario || it.error}</span>
      </li>`;
    }
    const color = it.action_color || "#1971c2";
    const urgencyCls = it.urgency === "立即" ? "it-urgent" : (it.urgency === "5分钟内" ? "it-soon" : "it-wait");
    const targetHtml = it.target_price
      ? `<span class="it-target">${it.target_type || "操作"} ${it.target_price}</span>`
      : "";
    const stopHtml = it.stop_loss
      ? `<span class="it-stop">止损 ${it.stop_loss}</span>`
      : "";
    const metrics = it.metrics || {};
    const metTxt = [
      metrics.now_pct != null ? `<b style="color:${metrics.now_pct >= 0 ? '#c92a2a' : '#2b8a3e'}">${metrics.now_pct >= 0 ? '+' : ''}${metrics.now_pct}%</b>` : "",
      metrics.kdj_j != null ? `KDJ J=${metrics.kdj_j} ${metrics.kdj_status || ''}${metrics.kdj_turn && metrics.kdj_turn !== '平稳' ? '·' + metrics.kdj_turn : ''}` : "",
      metrics.macd_status ? `MACD ${metrics.macd_status}` : "",
      metrics.vol_ratio != null ? `量比 ${metrics.vol_ratio}` : "",
      metrics.rsi != null ? `RSI ${metrics.rsi}` : "",
    ].filter(Boolean).join("　");
    const reasons = (it.reasons || []).slice(0, 3).join("；");
    return `<li class="intraday-row ${urgencyCls}" data-code="${row.code}"
        style="border-left:4px solid ${color};">
      <div class="it-head">
        <span class="it-scenario">${it.scenario}</span>
        <span class="it-name">${row.name}</span>
        <span class="it-action" style="color:${color}">${it.action}</span>
        <span class="it-urgency">${it.urgency}</span>
      </div>
      <div class="it-body">
        ${metTxt ? `<span class="it-metrics">${metTxt}</span>` : ""}
        ${targetHtml}
        ${stopHtml}
      </div>
      ${reasons ? `<div class="it-reasons" style="color:#555;font-size:12px;margin-top:2px">${reasons}</div>` : ""}
    </li>`;
  }

  // 正在看的股票每 8 秒自动重算评分+买卖建议（实时）
  function startLiveView() {
    state.timers.push(setInterval(async () => {
      if (!state.current.code) return;
      const { code, period } = state.current;
      const cap = $("#capInput").value || 100000;
      const hold = $("#holdInput").value || 0;
      try {
        const sig = await api("GET", "/api/signal?code=" + code + "&period=" + period + "&limit=120"
          + "&capital=" + cap + "&current_shares=" + hold);
        renderSignal(sig, true);
      } catch (e) { /* 网络抖动忽略 */ }
    }, 8000));
  }

  // ---------- 每日策略（开盘判断 / 四时点快照 / 收盘复盘） ----------
  async function pollDailyStrategy() {
    try {
      const data = await api("GET", "/api/daily_strategy");
      if (!data) return;
      state.daily = data;
      renderDaily(data);
    } catch (e) { /* ignore */ }
  }
  function _dsColor(action) {
    if (action === "买入") return "#2b8a3e";
    if (action === "卖出" || action === "减仓") return "#c92a2a";
    return "#868e96";
  }
  function renderDaily(d) {
    const phaseEl = document.getElementById("dailyPhase");
    if (phaseEl) {
      const now = new Date();
      const hm = now.getHours() * 60 + now.getMinutes();
      let ph = "盘前";
      if (hm >= 900) ph = "已收盘";
      else if (hm >= 570) ph = "交易中";
      phaseEl.textContent = (d.review ? "已复盘 · " : "") + ph;
    }
    const openEl = document.getElementById("dailyOpen");
    if (openEl) {
      const op = d.open;
      if (!op) {
        openEl.innerHTML = '<span class="sub" style="color:var(--muted)">开盘前暂未生成，9:25 后自动判断当天涨跌并给买卖价量。</span>';
      } else {
        const tr = { up: "↑ 看涨", down: "↓ 看跌", sideways: "→ 震荡" }[op.trend] || op.trend;
        const trColor = { up: "#2b8a3e", down: "#c92a2a", sideways: "#868e96" }[op.trend] || "#868e96";
        // 每日开盘建议表：按优先级展示（动作 + 评分 + 价格 + 数量）
        // 不再展示个股下面的一段分析，按"购买优先级"排序，最值得买的在最上
        const rows = (op.suggestions || []).map(s => {
          const ac = s.action || "持有";
          const score = s.score != null ? s.score : ((s.forecast || {}).pct != null ? Math.round((s.forecast.pct || 0) * 25) : 0);
          const scoreColor = score > 0 ? '#2b8a3e' : score < 0 ? '#c92a2a' : '#868e96';
          const fc = s.forecast || {};
          const fcTxt = fc.trend ? `<span style="margin-left:4px;color:${fc.trend==='偏多'?'#2b8a3e':fc.trend==='偏空'?'#c92a2a':'#868e96'}">${fc.trend}${fc.pct!=null?(fc.pct>=0?'+':'')+fc.pct.toFixed(2)+'%':''}</span>` : '';
          const qty = s.qty ? '×' + s.qty + '股' : (ac === '买入' ? '资金不足1手' : '');
          const actionLabel = ac === '买入' ? '强烈购买' : ac === '减仓' ? '减仓' : ac === '卖出' ? '止盈/止损' : ac === '持有' ? '持有' : ac;
          return '<tr><td><b>' + (s.name || s.code) + '</b><span style="color:#999;font-size:10px"> ' + s.code + '</span></td>' +
            '<td style="text-align:center;font-weight:700;font-variant-numeric:tabular-nums">¥' + (s.price != null ? s.price : '--') + '</td>' +
            '<td style="text-align:center;font-weight:800;color:#2b8a3e;font-variant-numeric:tabular-nums">' + (s.best_buy != null ? s.best_buy : '--') + '</td>' +
            '<td style="text-align:center;color:' + _dsColor(ac) + ';font-weight:700">' + actionLabel + '</td>' +
            '<td style="text-align:center;font-weight:800;color:' + scoreColor + '">' + (score>0?'+':'') + score + fcTxt + '</td>' +
            '<td style="text-align:right;color:#495057">' + qty + '</td></tr>';
        }).join('');
        const suggTable = rows
          ? '<table class="ds-table">' +
              '<thead><tr><th>股票</th><th style="text-align:center">当前价</th><th style="text-align:center">最佳买价</th><th style="text-align:center">建议</th><th style="text-align:center">评分/预估</th><th style="text-align:right">数量</th></tr></thead>' +
              '<tbody>' + rows + '</tbody></table>'
          : '<span class="sub" style="color:var(--muted)">无明确建议</span>';
        openEl.innerHTML = '<div style="margin:4px 0 6px"><b style="color:' + trColor + ';font-size:14px">' + tr + '</b> <span class="sub">置信度 ' + op.confidence + '%</span></div>' +
          '<div class="sub" style="font-size:11px;color:#666;margin-bottom:6px">' + (op.market_note || '') + '</div>' +
          suggTable;
      }
    }
    renderDailySnap(d);
    const revEl = document.getElementById("dailyReview");
    if (revEl) {
      const rv = d.review;
      if (!rv) {
        // 自动区分：今日尚未复盘（含未到 15:00 或今日无快照） vs 跨日累计
        const today = new Date().toISOString().slice(0, 10);
        const isToday = (d.date === today);
        if (isToday) {
          revEl.innerHTML = '<div class="rev-collecting">' +
            '<b>🟡 今日复盘还在累积</b><br>' +
            '· 9:30 / 10:00 / 10:30 / 13:00 / 14:00 五个时点会陆续记录建议价<br>' +
            '· 15:00 后会自动核对：每只股票的<b>建议价 vs 实际最高/最低/收盘</b><br>' +
            '· 今晚 17 点后这里就会有今天第一份完整的<b>胜率 / 做T盈亏 / 下次如何改进</b><br>' +
            '<span style="color:var(--muted);font-size:11px">（每日复盘需要至少一整天的数据积累，今天是启用第 1 天，明天起能看到准确率）</span>' +
          '</div>';
        } else {
          revEl.innerHTML = '<span class="sub" style="color:var(--muted)">' + (d.date || '今日') + ' 尚未到 15:00 / 暂无快照，等收盘后自动复盘。</span>';
        }
      } else {
        const s = rv.summary || {};
        const rows = (rv.rows || []).map(r => {
          const ca = r.correct == null ? "—" : (r.correct ? "✅" : "❌");
          const caColor = r.correct == null ? "#868e96" : (r.correct ? "#2b8a3e" : "#c92a2a");
          const pnl = r.pnl != null ? `<b style="color:${r.pnl >= 0 ? '#2b8a3e' : '#c92a2a'}">${r.pnl >= 0 ? '+' : ''}${r.pnl}</b>` : "—";
          const hit = r.hit == null ? "—" : (r.hit ? "触达" : "未触");
          return `<div class="ds-row"><span class="ds-name">${r.name}<span style="color:#999;font-size:10px"> ${r.code}</span></span>
            <span class="ds-act">${r.action || "—"}</span><span>@${r.price != null ? r.price : "—"}</span>
            <span>${hit}</span><span style="color:${caColor}">${ca}</span><span>盈亏${pnl}</span></div>`;
        }).join("");
        revEl.innerHTML = `<div style="margin:4px 0 2px"><b>胜率 ${s.win_rate != null ? s.win_rate : "—"}%</b>（${s.win_count || 0}/${s.evaluated || 0}）　<b style="color:${s.total_pnl >= 0 ? '#2b8a3e' : '#c92a2a'}">模拟盈亏 ${s.total_pnl >= 0 ? '+' : ''}${s.total_pnl != null ? s.total_pnl : '—'}</b></div>${rows}`;
      }
    }
  }
  function renderDailySnap(d) {
    const el = document.getElementById("dailySnap");
    if (!el) return;
    const t = state.dailySnapTab || "09:30";
    const snap = d.snapshots && d.snapshots[t];
    if (!snap) {
      el.innerHTML = `<span class="sub" style="color:var(--muted)">${t} 时点尚未记录（开盘后自动抓取，或等定时任务触发）。</span>`;
      return;
    }
    const rows = (snap.rows || []).map(s => {
      const ac = s.action || "持有";
      const qty = s.qty ? ` ×${s.qty}` : (ac === "买入" ? " 资金不足" : "");
      return `<div class="ds-row"><span class="ds-name">${s.name}</span>
        <span class="ds-act" style="color:${_dsColor(ac)}">${ac}</span>
        <span class="ds-price">${s.price != null ? ("@" + s.price) : ""}${qty}</span>
        <span class="ds-reason">${s.reason || ""}</span></div>`;
    }).join("");
    el.innerHTML = `<div class="sub" style="font-size:10px;color:#999;margin-bottom:2px">记录于 ${snap.ts}</div>${rows || '<span class="sub" style="color:var(--muted)">该时点无建议</span>'}`;
  }

  // ---------- 每日复盘 ----------
  async function loadReview() {
    const el = $("#reviewBox");
    if (!el) return;
    try {
      // 主数据源：/api/daily_strategy（含四时点 + 复盘 + calibration）
      let d = await api("GET", "/api/daily_strategy").catch(() => null);
      if (!d || d.error) return;
      const review = d.review;
      const open = d.open;
      const snaps = d.snapshots || {};
      // 1) 顶部汇总
      const summary = (review && review.summary) || {};
      const winRate = summary.win_rate || 0;
      const winColor = winRate >= 60 ? "#2b8a3e" : winRate >= 40 ? "#fab005" : "#c92a2a";
      const totalPnl = summary.total_pnl || 0;
      const summaryHtml = `<div class="rev-summary">
        <div class="rev-sum-item"><div class="rev-sum-label">准确率</div><div class="rev-sum-val" style="color:${winColor}">${winRate.toFixed(1)}%</div></div>
        <div class="rev-sum-item"><div class="rev-sum-label">建议次数</div><div class="rev-sum-val">${summary.evaluated || 0}</div></div>
        <div class="rev-sum-item"><div class="rev-sum-label">正确数</div><div class="rev-sum-val">${summary.win_count || 0}</div></div>
        <div class="rev-sum-item"><div class="rev-sum-label">做T累计盈亏</div><div class="rev-sum-val" style="color:${totalPnl >= 0 ? '#2b8a3e' : '#c92a2a'}">${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(0)}</div></div>
      </div>`;
      // 2) calibration 改进建议
      const cal = (review && review.calibration) || {};
      const tipsHtml = (cal.tips || []).map(t => `<li>${t}</li>`).join("");
      const calHtml = tipsHtml ? `<details class="rev-cal" open><summary>🎯 下次如何改进（自动校准）</summary><ul class="rev-cal-tips">${tipsHtml}</ul></details>` : "";
      // 3) 开盘判断 / 四时点 详细对比表（含非持仓候选股：开盘推荐买价 vs 尾盘收盘，是否盈利）
      const timeLabels = ["09:30", "10:00", "10:30", "13:00", "14:00"];
      const detailRows = [];
      if (open && open.suggestions) {
        open.suggestions.forEach(s => {
          detailRows.push({src: "开盘判断", role: s.role || "holding", code: s.code, name: s.name,
                           action: s.action, price: s.price, best_buy: s.best_buy, qty: s.qty});
        });
      }
      timeLabels.forEach(t => {
        const snap = snaps[t];
        if (snap && snap.rows) {
          snap.rows.forEach(s => {
            detailRows.push({src: t, role: s.role || "holding", code: s.code, name: s.name,
                             action: s.action, price: s.price, best_buy: s.best_buy, qty: s.qty});
          });
        }
      });
      // 与实际 high/low/close 比对（复盘重点：开盘推荐买价 vs 尾盘收盘，是否盈利）
      const reviewMap = {};
      (review && review.rows || []).forEach(r => {
        reviewMap[`${r.code}|${r.source}`] = r;
      });
      const tableRows = detailRows.map(dr => {
        const rev = reviewMap[`${dr.code}|${dr.src}`] || {};
        const recBuy = rev.rec_buy != null ? rev.rec_buy : (dr.best_buy != null ? dr.best_buy : dr.price);
        const cl = rev.close != null ? rev.close : null;
        // 是否盈利：买入类按「开盘推荐买价 → 尾盘收盘」；其余沿用对错判断
        const profit = rev.profit;
        const profitTxt = profit == null ? "—" : (profit ? "✅盈利" : "❌亏损");
        const profitColor = profit == null ? "#868e96" : (profit ? "#2b8a3e" : "#c92a2a");
        const pnl = rev.pnl != null ? `${rev.pnl >= 0 ? '+' : ''}${rev.pnl.toFixed(0)}` : "—";
        const pnlColor = rev.pnl == null ? '#868e96' : (rev.pnl >= 0 ? '#2b8a3e' : '#c92a2a');
        const ca = rev.correct == null ? "—" : (rev.correct ? "✅对" : "❌错");
        const caColor = rev.correct == null ? "#868e96" : (rev.correct ? "#2b8a3e" : "#c92a2a");
        const recBuyTxt = recBuy != null ? Number(recBuy).toFixed(2) : "—";
        const clTxt = cl != null ? cl.toFixed(2) : "—";
        const roleTag = dr.role === "candidate" ? '<span class="rev-tag tag-候选">候选</span>' : (dr.role === "holding" ? '<span class="rev-tag tag-持仓">持仓</span>' : "");
        const actColor = (dr.action === "买入" || dr.action === "强烈买入") ? "#2b8a3e" : (dr.action === "卖出" || dr.action === "减仓") ? "#c92a2a" : "#495057";
        const profitCol = profit == null ? `<span style="color:${caColor}">${ca}</span>` : `<span style="color:${profitColor};font-weight:700">${profitTxt}</span>`;
        return `<tr>
          <td>${dr.src}</td>
          <td>${dr.name || dr.code} ${roleTag}</td>
          <td style="color:${actColor};font-weight:600">${dr.action || '—'}</td>
          <td>${recBuyTxt}</td>
          <td>${clTxt}</td>
          <td style="color:${profitColor};font-weight:700">${profitCol}</td>
          <td style="color:${pnlColor};font-weight:600">${pnl}</td>
        </tr>`;
      }).join("");
      const tableHtml = tableRows ? `<details class="rev-detail" open><summary>📋 开盘推荐价 vs 尾盘收盘 · 是否盈利（点击折叠）</summary>
        <div style="font-size:10.5px;color:var(--muted);margin:2px 0 4px">盈利 = 尾盘收盘价 &gt; 开盘推荐买价（按推荐价买入的模拟收益，仅供复盘参考）</div>
        <table class="rev-table">
          <thead><tr><th>时点</th><th>股票</th><th>动作</th><th>开盘推荐买价</th><th>尾盘收</th><th>是否盈利</th><th>盈亏额(元)</th></tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </details>` : `<div style="color:var(--muted);font-size:11px">暂无对比数据（收盘后自动生成）</div>`;
      el.innerHTML = summaryHtml + calHtml + tableHtml;
    } catch (e) { /* ignore */ }
  }

  document.addEventListener("DOMContentLoaded", init);

  // ========== v3.1 视图切换 ==========
  function switchView(name) {
    if (!name) return;
    document.querySelectorAll('#sbNav li').forEach(li => {
      li.classList.toggle('active', li.dataset.view === name);
    });
    document.querySelectorAll('.view').forEach(v => {
      v.hidden = (v.dataset.view !== name);
    });
    if (name === 'dashboard') {
      try { renderSelfStocks(); } catch (e) { console.warn('[wb] dashboard render:', e && e.message); }
      try {
        if (!__tpCurrent.code) {
          const first = (state.positions || [])[0];
          if (first) renderStockDetail(first.code, first.name);
        } else {
          renderStockDetail(__tpCurrent.code, __tpCurrent.name);
        }
      } catch (e) { console.warn('[wb] default stock detail:', e && e.message); }
      try { loadMarketSentiment(); } catch (e) { console.warn('[wb] sentiment:', e && e.message); }
    } else if (name === 'scan') {
      try { renderScanView(); } catch (e) { console.warn('[wb] scan render:', e && e.message); }
      try { renderTailBuy(); } catch (e) { console.warn('[wb] tailbuy render:', e && e.message); }
    } else if (name === 'backtest') {
      // r36：策略回测视图改为「每日复盘」：自动加载历史记录 + 今日预测 + 累计正确率
      try { renderReview(); } catch (e) { console.warn('[wb] review render:', e && e.message); }
    } else if (name === 'account') {
      try {
        if (state.posAdvice && state.posAdvice.length) renderPosTable(state.posAdvice);
        else renderAccount();
      } catch (e) { console.warn('account 视图刷新失败：', e); }
    }
  }

  // r39：按 (code + period) 拉 K 线（顶层函数，被 renderStockDetail 与周期切换共用）
  // r40：按双标签模式拉 K 线（分时=1m / 日K+指标=daily），与顶部"周期"按钮解耦
  async function renderKlineAtPeriod() {
    const code = __tpCurrent.code;
    if (!code) return;
    const mode = __klineMode || "intraday";
    const period = (mode === "intraday") ? "1m" : "daily";
    const limit  = (mode === "intraday") ? 240 : 180;
    const cacheKey = code + "|" + mode;
    // 缓存秒出（按模式存）
    const cached = _klineCachePeriod[cacheKey];
    if (cached && cached.bars && cached.bars.length) {
      try { renderTpChart(cached.bars, cached.indicators || {}, mode, !!cached.isDemo); } catch (e) {}
    }
    try {
      const r = await api("GET", "/api/kline?code=" + encodeURIComponent(code)
                             + "&period=" + period + "&limit=" + limit);
      let bars = (r && r.bars) || [];
      let indicators = (r && r.indicators) || {};
      let isDemo = false;
      if (!bars.length) {
        // 演示兜底：接口暂不可达时避免空白
        const demo = buildDemoBars(mode);
        bars = demo.bars; indicators = demo.indicators; isDemo = true;
      }
      renderTpChart(bars, indicators, mode, isDemo);
      const metaText = isDemo ? "⚠️ 演示数据（接口暂不可达）" : "更新于 " + new Date().toLocaleTimeString("zh-CN", { hour12: false });
      _klineCachePeriod[cacheKey] = { bars, indicators, isDemo, metaText };
      const meta = document.getElementById("tradePlanMeta");
      if (meta) meta.textContent = metaText;
    } catch (e) { console.warn("[wb] kline period:", e && e.message); }
  }

  function bindNav() {
    document.querySelectorAll('#sbNav li').forEach(li => {
      li.addEventListener('click', () => switchView(li.dataset.view));
    });
  }

  // ========== 顶部控制栏 + 侧栏 + 扫描标签交互（r34） ==========
  function bindTopbar() {
    let autoTimer = null;  // 自动刷新定时器句柄

    // 顶部"周期"按钮（5分/15分/日/周）：仅控制 AI 决策所用周期，不再联动 K 线图表（与双标签解耦）
    document.querySelectorAll('#periodSwitch .tb-chip').forEach(b => {
      b.addEventListener('click', () => {
        document.querySelectorAll('#periodSwitch .tb-chip').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        const newP = b.dataset.period || "5m";
        if (__tpCurrent.period === newP) return;
        __tpCurrent.period = newP;
        // 按所选周期重新拉信号、刷新 AI 决策（不影响 K 线双标签）
        if (__tpCurrent.code) {
          api("GET", "/api/signal?code=" + encodeURIComponent(__tpCurrent.code) + "&period=" + newP + "&limit=180")
            .then(sig => { if (sig && sig.ok) _renderTradePlan(sig, __tpCurrent.code, __tpCurrent.name); })
            .catch(() => {});
        }
      });
    });

    // r40：K线区双标签（分时 / 日K+指标）—— 控制图表渲染模式，互相独立
    document.querySelectorAll('#klineTabs .tp-tab').forEach(b => {
      b.addEventListener('click', () => {
        document.querySelectorAll('#klineTabs .tp-tab').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        const newMode = b.dataset.mode || "intraday";
        if (__klineMode === newMode) { renderKlineAtPeriod(); return; }  // 同模式：刷新
        __klineMode = newMode;
        renderKlineAtPeriod();
      });
    });

    // 2) 自动刷新：勾选后按间隔重拉股票详情 + 大盘情绪（r39：默认开启，默认 5 秒）
    const arEl = document.getElementById('autoRefresh');
    const riEl = document.getElementById('refreshInterval');
    function applyAutoRefresh() {
      if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
      if (arEl && arEl.checked) {
        const sec = Math.max(1, parseInt(riEl && riEl.value, 10) || 2);   // r40n：默认 2 秒；允许 1 秒 → 配合 renderTpChart 的 merge 模式做"实时跟随不刷新整图"
        autoTimer = setInterval(async () => {
          if (!__tpCurrent.code) return;
          // r40n：轻量实时通道 —— 不调 renderStockDetail（那套会重拉信号/策略、重画 AI 决策区、header 倒退为"加载中…"）
          //       只轮询最新 K 线，直接走 renderTpChart 的 merge 模式：只更新折线/量能 series，grid/yAxis/header 完全不动 → 界面平滑跟随、不闪、不卡
          const mode = __klineMode || "intraday";
          const period = (mode === "intraday") ? "1m" : "daily";
          const limit  = (mode === "intraday") ? 240 : 180;
          try {
            const r = await api("GET", "/api/kline?code=" + encodeURIComponent(__tpCurrent.code)
                                       + "&period=" + period + "&limit=" + limit);
            const bars = (r && r.bars) || [];
            if (!bars.length) return;   // 接口空 → 保持当前图，不降级、不闪
            renderTpChart(bars, (r && r.indicators) || {}, mode, false);
          } catch (e) {}
          try { loadMarketSentiment(); } catch (e) {}
        }, sec * 1000);
        // 默认静默开启，不弹 toast
      }
    }
    if (arEl) {
      arEl.addEventListener('change', () => {
        applyAutoRefresh();
        if (arEl.checked) {
          const sec = Math.max(1, parseInt(riEl && riEl.value, 10) || 5);
          toast('已开启自动刷新（每 ' + sec + ' 秒）');
        } else {
          toast('已关闭自动刷新');
        }
      });
    }
    if (riEl) riEl.addEventListener('change', () => { if (arEl && arEl.checked) applyAutoRefresh(); });
    // r39：首屏自动开启（HTML 里 checkbox 已 checked）
    applyAutoRefresh();

    // 3) 明暗主题切换（localStorage 持久化）
    const themeBtn = document.getElementById('themeToggle');
    function applyTheme(t) {
      document.body.classList.toggle('theme-dark', t === 'dark');
      document.body.classList.toggle('theme-light', t === 'light');
      if (themeBtn) themeBtn.textContent = (t === 'dark') ? '🌙' : '☀️';
    }
    if (themeBtn) {
      themeBtn.addEventListener('click', () => {
        const t = document.body.classList.contains('theme-light') ? 'dark' : 'light';
        try { localStorage.setItem('wb_theme', t); } catch (e) {}
        applyTheme(t);
        toast(t === 'dark' ? '已切换夜间模式' : '已切换日间模式');
      });
    }
    // 首屏应用已保存主题（默认夜间）
    let savedTheme = 'dark';
    try { savedTheme = localStorage.getItem('wb_theme') || 'dark'; } catch (e) {}
    applyTheme(savedTheme);

    // 4) 侧栏收起 / 展开
    const sbToggle = document.getElementById('sidebarToggle');
    if (sbToggle) sbToggle.addEventListener('click', () => {
      const sb = document.getElementById('sidebar');
      if (sb) sb.classList.toggle('collapsed');
    });

    // 5) 右下扫描区：扫描候选 / 尾盘 / 自选监控 三标签切换
    const paneMap = { cand: 'paneCand', tail: 'paneTail', watch: 'paneWatch' };
    document.querySelectorAll('.scan-tab').forEach(b => {
      b.addEventListener('click', () => {
        const tab = b.dataset.tab;
        if (!tab) return;
        document.querySelectorAll('.scan-tab').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        Object.values(paneMap).forEach(id => { const el = document.getElementById(id); if (el) el.hidden = true; });
        const pane = document.getElementById(paneMap[tab]);
        if (pane) pane.hidden = false;
        if (tab === 'tail') { try { renderTailBuy(); } catch (e) { console.warn('[wb] tailbuy:', e && e.message); } }
        else if (tab === 'watch') { try { renderSelfStocks(); } catch (e) { console.warn('[wb] selfstocks:', e && e.message); } }
      });
    });

    // r37：删除决策面板「查看回测」按钮（账户总览输入区已一并删除，需要回测可从侧栏进）
  }

  // 简易信号扫描双列（适配 v3.1 详情页：买入候选红色 / 卖出候选绿色）
  // r40q：视图1 (scanBuyList) + 视图2 (scanBuyList2) 同时填，避免侧栏切到「选股扫描」后整个面板永远空
  function renderScanView() {
    const buyEls  = Array.from(document.querySelectorAll('[id^="scanBuyList"]'));
    const sellEls = Array.from(document.querySelectorAll('[id^="scanSellList"]'));
    if (!buyEls.length || !sellEls.length) return;
    const paint = (msg) => {
      buyEls.forEach(el  => el.innerHTML  = `<div class="empty-v3">${msg}</div>`);
      sellEls.forEach(el => el.innerHTML = `<div class="empty-v3">${msg}</div>`);
    };
    paint('加载中…');
    fetch('/api/scan_status').then(r => r.json()).then(data => {
      const results = (data && data.results) || [];
      const MAX = 100;  // 买入/卖出各最多展示 100 条，三百多条全显示（原 r20 限 5 条太少了）
      const buyAll = results.filter(r => {
        const a = (r.action || '').toLowerCase();
        return a.includes('buy') || a.includes('买入') || a.includes('加仓');
      });
      const sellAll = results.filter(r => {
        const a = (r.action || '').toLowerCase();
        return a.includes('sell') || a.includes('卖出') || a.includes('减仓');
      });
      // 按综合分降序
      buyAll.sort((a, b) => (b.combined ?? b.score ?? 0) - (a.combined ?? a.score ?? 0));
      sellAll.sort((a, b) => (b.combined ?? b.score ?? 0) - (a.combined ?? a.score ?? 0));
      const buy  = buyAll.slice(0, MAX);
      const sell = sellAll.slice(0, MAX);
      const rowHtml = (r, idx) => {
        const px  = r.price != null ? r.price.toFixed(2) : '--';
        const chg = r.change_pct != null ? (r.change_pct >= 0 ? '+' : '') + r.change_pct.toFixed(2) + '%' : '';
        const chgCls = r.change_pct == null ? '' : (r.change_pct >= 0 ? 'up' : 'down');
        const sc  = r.score != null ? r.score : (r.advice_score != null ? r.advice_score : (r.combined != null ? r.combined : 0));
        const track = r.track ? `<span class="sr-track">${r.track}</span>` : '';
        return `<div class="scan-row" data-code="${r.code || ''}">
          <span class="sr-idx">${idx + 1}</span>
          <span class="sr-name">${r.name || r.code || '--'}</span>
          <span class="sr-code">${r.code || ''}</span>
          <span class="sr-price">¥${px}</span>
          <span class="sr-chg ${chgCls}">${chg}</span>
          <span class="sr-score">${sc}</span>
        </div>`;
      };
      const headerHtml = (total) => `<div class="scan-header"><span>#</span><span>名称</span><span>代码</span><span class="r">现价</span><span class="r">涨跌</span><span class="r">评分</span></div>`;
      // r28：把头部"5"改成动态真实命中数（视图1 + 视图2 两套 count 一起更）
      const buyCntEls  = Array.from(document.querySelectorAll('[id^="scanBuyCount"]'));
      const sellCntEls = Array.from(document.querySelectorAll('[id^="scanSellCount"]'));
      buyCntEls.forEach(el  => el.textContent  = buyAll.length);
      sellCntEls.forEach(el => el.textContent = sellAll.length);
      const buyHtml  = buy.length  ? headerHtml(buyAll.length)  + buy.map(rowHtml).join('')  : '<div class="empty-v3">暂无买入候选</div>';
      const sellHtml = sell.length ? headerHtml(sellAll.length) + sell.map(rowHtml).join('') : '<div class="empty-v3">暂无卖出候选</div>';
      buyEls.forEach(el  => el.innerHTML = buyHtml);
      sellEls.forEach(el => el.innerHTML = sellHtml);
    }).catch(e => paint('信号扫描失败：' + (e.message || e)));
  }

  // ========== r27 尾盘买入法 ==========
  // 每天 14:50~14:58 推荐 2-3 只大A纯主板（沪 60/601/603/605；深 000/001/002），
  // 排除创业板（30x）、北交所（83x/87x/43x）、可转债等；策略详见 HTML 注释
  // r40q：视图1 (tailbuyPickList) + 视图2 (tailbuyPickList2) 同时填
  async function renderTailBuy(forceRefresh) {
    const pickEls = Array.from(document.querySelectorAll('[id^="tailbuyPickList"]'));
    const poolEls = Array.from(document.querySelectorAll('[id^="tailbuyPoolList"]'));
    const pickCnts = Array.from(document.querySelectorAll('[id^="tailbuyPickCount"]'));
    const poolCnts = Array.from(document.querySelectorAll('[id^="tailbuyPoolCount"]'));
    const statEls  = Array.from(document.querySelectorAll('[id^="tailbuyStatus"]'));
    if (!pickEls.length || !poolEls.length) return;
    pickEls.forEach(el => el.innerHTML = '<div class="tailbuy-empty">加载中…（扫全主板约 5-10 秒）</div>');
    poolEls.forEach(el => el.innerHTML = '<div class="tailbuy-empty">加载中…</div>');
    statEls.forEach(el => el.textContent = '运行中…');
    try {
      const url = '/api/tail_buy' + (forceRefresh ? '?force=1' : '');
      const data = await api('GET', url);
      if (!data || !data.ok) throw new Error((data && data.error) || '无响应');
      const picks = data.picks || [];
      const pool = data.pool || [];
      pickCnts.forEach(el => el.textContent = picks.length);
      poolCnts.forEach(el => el.textContent = pool.length);
      statEls.forEach(el => el.textContent = data.generated_at ? '更新于 ' + data.generated_at : '已生成');
      const card = (r, isPick) => {
        const px = r.price != null ? fmt(r.price) : '--';
        const chg = r.change_pct != null ? (r.change_pct >= 0 ? '+' : '') + r.change_pct.toFixed(2) + '%' : '';
        const chgCls = r.change_pct == null ? '' : (r.change_pct >= 0 ? 'up' : 'down');
        const sc = r.score != null ? r.score : '--';
        const tags = (r.rules_hit || []).map(h => `<span class="tb-rule-tag">${h}</span>`).join('');
        const noTags = (r.rules_miss || []).map(h => `<span class="tb-rule-tag no">${h}</span>`).join('');
        const next = r.next_open != null ? `<b style="color:#fff">${fmt(r.next_open)}</b>` : '<b style="color:var(--muted)">—</b>';
        const sl = r.stop_loss != null ? `<b style="color:#e74c3c">${fmt(r.stop_loss)}</b>` : '<b style="color:var(--muted)">—</b>';
        const tp = r.take_profit != null ? `<b style="color:#2ecc71">${fmt(r.take_profit)}</b>` : '<b style="color:var(--muted)">—</b>';
        const amp = r.amp_pct != null ? r.amp_pct.toFixed(1) + '%' : '--';
        return `<div class="tailbuy-card ${isPick ? 'tb-pick' : ''}" data-code="${r.code}">
          <div class="tb-top">
            <span class="tb-name">${r.name || r.code}<i class="tb-code">${r.code}</i></span>
            <span class="tb-px">¥${px}</span>
            <span class="tb-chg ${chgCls}">${chg}</span>
            <span class="tb-score">${sc}</span>
          </div>
          <div class="tb-mid">
            <div class="tb-mid-cell"><span>振幅</span><b>${amp}</b></div>
            <div class="tb-mid-cell"><span>量比</span><b>${r.vol_ratio != null ? r.vol_ratio.toFixed(2) : '--'}</b></div>
            <div class="tb-mid-cell"><span>主力净流</span><b style="color:${(r.main_fund_net||0) >= 0 ? '#e74c3c' : '#2ecc71'}">${r.main_fund_net != null ? (r.main_fund_net >= 0 ? '+' : '') + r.main_fund_net.toFixed(2) + '亿' : '--'}</b></div>
            <div class="tb-mid-cell"><span>换手</span><b>${r.turnover != null ? r.turnover.toFixed(1) + '%' : '--'}</b></div>
          </div>
          <div class="tb-mid">
            <div class="tb-mid-cell"><span>次日开</span>${next}</div>
            <div class="tb-mid-cell"><span>止损</span>${sl}</div>
            <div class="tb-mid-cell"><span>目标</span>${tp}</div>
            <div class="tb-mid-cell"><span>持有</span><b>1-3 天</b></div>
          </div>
          <div class="tb-rules-hit">${tags}${noTags}</div>
        </div>`;
      };
      const pickHtml = picks.length
        ? picks.map(r => card(r, true)).join('')
        : '<div class="tailbuy-empty">暂无达标（可能不在 14:50 后或主板无满足全部条件的票）</div>';
      const poolHtml = pool.length
        ? pool.slice(0, 30).map(r => card(r, false)).join('')
        : '<div class="tailbuy-empty">候选池为空</div>';
      pickEls.forEach(el => el.innerHTML = pickHtml);
      poolEls.forEach(el => el.innerHTML = poolHtml);
      // 点击卡片打开个股详情（两套 panel 都绑一次）
      [].concat(pickEls, poolEls).forEach(box => {
        box.querySelectorAll('.tailbuy-card').forEach(c => {
          c.addEventListener('click', () => openStock(c.dataset.code, c.dataset.code));
        });
      });
    } catch (e) {
      const errHtml = `<div class="tailbuy-empty">尾盘买入法加载失败：${(e && e.message) || e}<br><span style="font-size:11px">首次会缓存股票池，1-2 分钟后重试</span></div>`;
      pickEls.forEach(el => el.innerHTML = errHtml);
      poolEls.forEach(el => el.innerHTML = '');
      statEls.forEach(el => el.textContent = '加载失败');
    }
  }

  // ========== r27 复盘视图 ==========
  async function renderReview() {
    const elMeta = document.getElementById('todayPredMeta');
    const body = document.getElementById('todayPredBody');
    const hist = document.getElementById('reviewHistoryList');
    if (!body || !hist) return;
    body.innerHTML = '<tr><td colspan="15" class="empty-cell">加载今日预测中…</td></tr>';
    hist.innerHTML = '<div class="dash-monitor-empty">加载历史记录中…</div>';
    try {
      // 1) 今日预测
      const td = await api('GET', '/api/review/today');
      const today = td.prediction || td || {};
      const rows = today.rows || [];
      if (elMeta) {
        elMeta.innerHTML = today.date
          ? `<b>${today.date}</b>　生成于 ${today.generated_at || today.date + ' 09:30'}　置信度 ${today.confidence || '--'}%　${today.market_note || ''}`
          : '今日尚未生成预测 — 点击右上「立即生成今日预测」';
      }
      body.innerHTML = rows.length
        ? rows.map(r => {
          const dirActual = r.dir_actual || '-';
          const dirPred = r.dir_pred || '-';
          const dirCell = (dirActual === 'up') ? '<span class="tp-dir-h">↑ 涨</span>'
                        : (dirActual === 'down') ? '<span class="tp-dir-w">↓ 跌</span>'
                        : '<span class="tp-dir-x">→ 平</span>';
          const dirHit = (dirPred === dirActual) ? '<span class="tp-acc-ok">✓</span>'
                       : (dirPred && dirActual && dirPred !== '-') ? '<span class="tp-acc-no">✗</span>'
                       : '<span class="tp-acc-mid">待</span>';
          const ampHit = (r.amp_pred != null && r.amp_actual != null)
            ? (Math.abs(r.amp_actual - r.amp_pred) < 1 ? '<span class="tp-acc-ok">✓</span>'
              : Math.abs(r.amp_actual - r.amp_pred) < 3 ? '<span class="tp-acc-mid">≈</span>'
              : '<span class="tp-acc-no">✗</span>')
            : '<span class="tp-acc-mid">待</span>';
          const hiHit = (r.high_pred != null && r.high_actual != null)
            ? (Math.abs(r.high_actual - r.high_pred) / Math.max(r.high_pred, 0.01) < 0.01 ? '<span class="tp-acc-ok">✓</span>'
              : Math.abs(r.high_actual - r.high_pred) / Math.max(r.high_pred, 0.01) < 0.03 ? '<span class="tp-acc-mid">≈</span>'
              : '<span class="tp-acc-no">✗</span>')
            : '<span class="tp-acc-mid">待</span>';
          const loHit = (r.low_pred != null && r.low_actual != null)
            ? (Math.abs(r.low_actual - r.low_pred) / Math.max(r.low_pred, 0.01) < 0.01 ? '<span class="tp-acc-ok">✓</span>'
              : Math.abs(r.low_actual - r.low_pred) / Math.max(r.low_pred, 0.01) < 0.03 ? '<span class="tp-acc-mid">≈</span>'
              : '<span class="tp-acc-no">✗</span>')
            : '<span class="tp-acc-mid">待</span>';
          return `<tr class="tp-row-pos">
            <td class="name"><b>${r.name || r.code}</b><br><span class="code">${r.code}</span></td>
            <td class="r">${r.open_pred != null ? fmt(r.open_pred) : '—'}</td>
            <td class="r">${r.high_pred != null ? fmt(r.high_pred) : '—'}</td>
            <td class="r">${r.low_pred != null ? fmt(r.low_pred) : '—'}</td>
            <td class="r">${r.close_pred != null ? fmt(r.close_pred) : '—'}</td>
            <td class="r ${(r.amp_pred||0) >= 0 ? 'up' : 'down'}">${r.amp_pred != null ? (r.amp_pred >= 0 ? '+' : '') + r.amp_pred.toFixed(2) + '%' : '—'}</td>
            <td class="r">${r.open_actual != null ? fmt(r.open_actual) : '—'}</td>
            <td class="r">${r.high_actual != null ? fmt(r.high_actual) : '—'}</td>
            <td class="r">${r.low_actual != null ? fmt(r.low_actual) : '—'}</td>
            <td class="r">${r.close_actual != null ? fmt(r.close_actual) : '—'}</td>
            <td class="r ${(r.amp_actual||0) >= 0 ? 'up' : 'down'}">${r.amp_actual != null ? (r.amp_actual >= 0 ? '+' : '') + r.amp_actual.toFixed(2) + '%' : '—'}</td>
            <td>${dirHit}</td><td>${ampHit}</td><td>${hiHit}</td><td>${loHit}</td>
          </tr>`;
        }).join('')
        : '<tr><td colspan="15" class="empty-cell">尚未生成今日预测</td></tr>';

      // 2) 历史记录
      const hd = await api('GET', '/api/review/history');
      const history = hd.history || [];
      hist.innerHTML = history.length
        ? history.map(day => {
          const dr = day.stats || {};
          return `<div class="rh-day">
            <div class="rh-day-head">
              <span>📅 ${day.date}　<b>${day.market_note || ''}</b></span>
              <span class="rh-day-stats">
                共 <b>${dr.total || 0}</b> 只 · 方向 <span class="ok">${dr.dir_hit || 0}</span>/<span class="no">${dr.dir_miss || 0}</span>
                · 幅度 <span class="ok">${dr.amp_hit || 0}</span>/<span class="no">${dr.amp_miss || 0}</span>
                · 高 <span class="ok">${dr.hi_hit || 0}</span>/<span class="no">${dr.hi_miss || 0}</span>
                · 低 <span class="ok">${dr.lo_hit || 0}</span>/<span class="no">${dr.lo_miss || 0}</span>
              </span>
            </div>
            <table class="rh-day-table">
              <thead><tr>
                <th>持仓</th><th>方向</th><th>预测%</th><th>实际%</th><th>幅度</th><th>高</th><th>低</th>
              </tr></thead>
              <tbody>${(day.rows || []).map(r => {
                const dir = r.dir_actual || '-';
                const dirCell = (dir === 'up') ? '<span class="tp-dir-h">↑</span>' : (dir === 'down') ? '<span class="tp-dir-w">↓</span>' : '<span class="tp-dir-x">→</span>';
                return `<tr>
                  <td>${r.name || r.code}</td>
                  <td>${dirCell}</td>
                  <td>${r.amp_pred != null ? (r.amp_pred >= 0 ? '+' : '') + r.amp_pred.toFixed(2) + '%' : '—'}</td>
                  <td>${r.amp_actual != null ? (r.amp_actual >= 0 ? '+' : '') + r.amp_actual.toFixed(2) + '%' : '—'}</td>
                  <td>${r.dir_hit ? '<span class="tp-acc-ok">✓</span>' : '<span class="tp-acc-no">✗</span>'}</td>
                  <td>${r.amp_hit ? '<span class="tp-acc-ok">✓</span>' : r.amp_hit === false ? '<span class="tp-acc-no">✗</span>' : '—'}</td>
                  <td>${r.hi_hit ? '<span class="tp-acc-ok">✓</span>' : r.hi_hit === false ? '<span class="tp-acc-no">✗</span>' : '—'}</td>
                  <td>${r.lo_hit ? '<span class="tp-acc-ok">✓</span>' : r.lo_hit === false ? '<span class="tp-acc-no">✗</span>' : '—'}</td>
                </tr>`;
              }).join('')}</tbody>
            </table>
          </div>`;
        }).join('')
        : '<div class="dash-monitor-empty">尚无历史记录</div>';

      // 3) 累计统计
      const sd = await api('GET', '/api/review/stats');
      const s = sd.stats || {};
      const setv = (id, v, cls) => { const e = document.getElementById(id); if (e) { e.textContent = v; e.classList.remove('up', 'down'); if (cls) e.classList.add(cls); } };
      setv('rvTotalDays', s.total_days != null ? s.total_days + ' 天' : '--');
      setv('rvDirAcc', s.dir_acc != null ? s.dir_acc + '%' : '--', (s.dir_acc || 0) >= 60 ? 'up' : 'down');
      setv('rvPctErr', s.amp_mae != null ? s.amp_mae.toFixed(2) + '%' : '--');
      setv('rvHiAcc', s.hi_acc != null ? s.hi_acc + '%' : '--', (s.hi_acc || 0) >= 60 ? 'up' : 'down');
      setv('rvLoAcc', s.lo_acc != null ? s.lo_acc + '%' : '--', (s.lo_acc || 0) >= 60 ? 'up' : 'down');
    } catch (e) {
      body.innerHTML = `<tr><td colspan="15" class="empty-cell">加载失败：${(e && e.message) || e}</td></tr>`;
      hist.innerHTML = `<div class="dash-monitor-empty">加载失败：${(e && e.message) || e}</div>`;
    }
  }
  // r27：复盘视图的"立即生成今日预测" / "核对今日实际"两个按钮
  // r40o：支持 scope（持仓/自选股/全部精选池）+ 异步任务进度面板 + 停止
  let _rvProgressTimer = null;
  function bindReviewButtons() {
    const btnP = document.getElementById('rvPredictBtn');
    const btnStop = document.getElementById('rvPredictStopBtn');
    const btnC = document.getElementById('rvCheckBtn');
    const scopeEl = document.getElementById('rvPredictScope');
    const refresh = document.querySelectorAll('[id^="tailbuyRefresh"]');

    const showProgress = (show) => {
      const panel = document.getElementById('rvProgressPanel');
      if (panel) panel.hidden = !show;
      if (btnP) btnP.disabled = show;
      if (btnStop) btnStop.hidden = !show;
    };

    const updateProgress = (p) => {
      if (!p) return;
      const fill = document.getElementById('rvProgressFill');
      const counter = document.getElementById('rvProgressCounter');
      const eta = document.getElementById('rvProgressEta');
      const lastCode = document.getElementById('rvProgressLastCode');
      const failed = document.getElementById('rvProgressFailed');
      const title = document.getElementById('rvProgressTitle');
      const pct = p.progress_pct || 0;
      if (fill) fill.style.width = pct.toFixed(1) + '%';
      if (counter) counter.textContent = (p.done || 0) + ' / ' + (p.total || 0) + ' (' + pct.toFixed(1) + '%)';
      if (eta) eta.textContent = p.eta_sec ? '预计剩余：' + _fmtSec(p.eta_sec) : '预计剩余：--';
      if (lastCode) lastCode.textContent = p.last_code ? ('当前：' + p.last_code) : '当前：--';
      if (failed) failed.textContent = '失败：' + (p.failed || 0);
      const scopeLabel = { positions: '持仓', watchlist: '自选股', all_main: '纯主板', all_market: '全 A' }[p.scope] || p.scope;
      if (title) title.textContent = (p.running ? '⏳ 预测中' : '✅ 已完成') + ' · ' + scopeLabel;
    };

    if (btnP) btnP.addEventListener('click', async () => {
      const scope = (scopeEl && scopeEl.value) || 'positions';
      btnP.disabled = true;
      const origText = btnP.textContent;
      btnP.textContent = '启动中…';
      try {
        const r = await api('POST', '/api/review/predict', { scope });
        if (scope === 'positions') {
          // 同步模式：直接出结果
          toast(r && r.ok ? ('已生成今日预测（' + (r.count || 0) + ' 只）') : '生成失败：' + (r && r.error || '未知'));
          renderReview();
        } else {
          // 异步模式：显示进度面板，启动轮询
          toast('已启动预测任务（' + scope + '），后台继续…');
          showProgress(true);
          _startProgressPoll();
        }
      } catch (e) { toast('生成失败：' + (e && e.message || e)); }
      btnP.disabled = false;
      btnP.textContent = origText;
    });

    if (btnStop) btnStop.addEventListener('click', async () => {
      btnStop.disabled = true;
      try {
        await api('POST', '/api/review/predict/stop', {});
        toast('已请求停止任务');
      } catch (e) { toast('停止失败：' + (e && e.message || e)); }
      btnStop.disabled = false;
    });

    if (btnC) btnC.addEventListener('click', async () => {
      btnC.disabled = true; btnC.textContent = '核对中…';
      try {
        const r = await api('POST', '/api/review/check', {});
        toast(r && r.ok ? '已核对（方向 ' + (r.dir_hit || 0) + '/' + (r.dir_total || 0) + '）' : '核对失败：' + (r && r.error || '未知'));
        renderReview();
      } catch (e) { toast('核对失败：' + (e && e.message || e)); }
      btnC.disabled = false; btnC.textContent = '核对今日实际';
    });

    if (refresh && refresh.length) refresh.forEach(b => b.addEventListener('click', () => renderTailBuy(true)));

    // 视图打开时：若后台有未完成任务，恢复进度面板
    (async () => {
      try {
        const p = await api('GET', '/api/review/progress');
        if (p && p.running) {
          showProgress(true);
          updateProgress(p);
          _startProgressPoll();
        } else if (p && p.scope) {
          // 已完成，留记录可查，但不显示进度条
          updateProgress(p);
        }
      } catch (e) {}
    })();

    function _startProgressPoll() {
      if (_rvProgressTimer) return;
      _rvProgressTimer = setInterval(async () => {
        try {
          const p = await api('GET', '/api/review/progress');
          if (!p) return;
          updateProgress(p);
          if (!p.running) {
            clearInterval(_rvProgressTimer);
            _rvProgressTimer = null;
            toast('预测完成（' + (p.done || 0) + ' / ' + (p.total || 0) + '）');
            renderReview();
            // 完成后 3 秒自动隐藏进度条
            setTimeout(() => showProgress(false), 3000);
          }
        } catch (e) {}
      }, 1000);
    }

    function _fmtSec(sec) {
      if (sec < 60) return sec + ' 秒';
      if (sec < 3600) return Math.floor(sec / 60) + ' 分 ' + (sec % 60) + ' 秒';
      return Math.floor(sec / 3600) + ' 小时 ' + Math.floor((sec % 3600) / 60) + ' 分';
    }
  }

  // ========== r28 行情看板·短线 K 线图 ==========
  let _klineChart = null;       // StockChart 实例
  let _klineState = { code: "", name: "", period: "5m", timer: null };

  // r29：把旧简易 K 线（chart.js + canvas）替换为新交易计划面板的事件绑定
  // Tab 切换 / 刷新 / 模拟建仓 / 资金风控参数变更
  function bindKline() {
    bindTradePlan();
  }
  function bindTradePlan() {
    // Tab：分时 / 日K+指标（暂用日K，分时图按需后续加）
    document.querySelectorAll('#tradePlanBody .tp-tab').forEach(b => {
      b.addEventListener('click', () => {
        document.querySelectorAll('#tradePlanBody .tp-tab').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        // 周期切换：重新拉 /api/kline + /api/signal 重绘（r30 可接入；当前先刷新指标）
        const period = b.dataset.p || 'daily';
        if (__tpCurrent.code && (period === 'm5')) {
          // 切到分时：从 /api/kline 取 5 分钟折线重画
          api('GET', '/api/kline?code=' + encodeURIComponent(__tpCurrent.code) + '&period=5m&limit=120')
            .then(r => { if (r && r.bars) renderTpChart(r.bars, (r.indicators || {}), 'intraday', false); })
            .catch(() => {});
        } else if (__tpCurrent.code) {
          // 切回日K：重渲染
          renderStockDetail(__tpCurrent.code, __tpCurrent.name);
        }
      });
    });
    // r31：短线策略模式切换（隔夜抢仓 / 日内做T）
    document.querySelectorAll('#tpStrategy .tp-stab').forEach(b => {
      b.addEventListener('click', () => {
        // r38：防止用户连点造成并发请求（旧请求 cancel 掉）
        if (_stratLoading) return;
        document.querySelectorAll('#tpStrategy .tp-stab').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        b.classList.add('loading');
        _loadStrategy(b.dataset.mode, b);
      });
    });
    // r32：策略历史回测按钮
    const btBtn = document.getElementById('tpBacktestBtn');
    if (btBtn) btBtn.addEventListener('click', () => _loadBacktest());
    // r37：删除 tpCapital/tpRisk/tpSimulateBuy/tpRefresh/tpToBacktest 事件绑定（账户总览输入区已删）
  }

  // r31：短线策略模式：加载并渲染隔夜抢仓 / 日内做T 结果
  let _stratLoading = false;
  async function _loadStrategy(mode, btn) {
    const code = __tpCurrent.code;
    if (!code) { toast('请先点左侧股票'); return; }
    const body = document.getElementById('tpStrategyBody');
    if (body) body.innerHTML = '<div class="tp-strategy-hint"><span class="tp-spin"></span> 计算中…</div>';
    _stratLoading = true;
    try {
      const r = await api('GET', '/api/strategy/' + mode + '?code=' + encodeURIComponent(code));
      _renderStrategyResult(mode, r);
    } catch (e) {
      if (body) body.innerHTML = '<div class="tp-strategy-hint">加载失败：' + (e && e.message || e) + '</div>';
    } finally {
      _stratLoading = false;
      if (btn) btn.classList.remove('loading');
    }
  }

  // r32：策略历史回测：并行跑隔夜/日内两个接口并渲染报告
  async function _loadBacktest() {
    const code = __tpCurrent.code;
    if (!code) { toast('请先点左侧股票'); return; }
    const body = document.getElementById('tpBacktestBody');
    if (body) body.innerHTML = '<div class="tp-strategy-hint">回测中（拉取历史K线，约 2-5 秒）…</div>';
    try {
      const [ov, id] = await Promise.all([
        api('GET', '/api/backtest/overnight?code=' + encodeURIComponent(code)),
        api('GET', '/api/backtest/intraday?code=' + encodeURIComponent(code)),
      ]);
      _renderBacktestReport(ov, id);
    } catch (e) {
      if (body) body.innerHTML = '<div class="tp-strategy-hint">回测失败：' + (e && e.message || e) + '</div>';
    }
  }

  function _renderBacktestReport(ov, id) {
    const body = document.getElementById('tpBacktestBody');
    if (!body) return;
    if ((!ov || !ov.ok) && (!id || !id.ok)) {
      body.innerHTML = '<div class="tp-strategy-hint">' + ((ov && ov.msg) || (id && id.msg) || '暂无回测数据') + '</div>';
      return;
    }
    let html = '';
    if (ov && ov.ok) {
      const s = ov.stats || {};
      const eq = s.equity_curve || [];
      html += '<div class="bt-card"><div class="bt-card-title">🌙 隔夜抢仓 · 历史回测</div>';
      html += '<div class="bt-sample">样本 ' + (ov.sample ? (ov.sample.from + ' ~ ' + ov.sample.to + '（' + ov.sample.bars + ' 根日线）') : '') + '</div>';
      html += '<div class="bt-grid">'
        + _btCell('交易笔数', s.trades)
        + _btCell('胜率', s.win_rate + '%', s.win_rate >= 55 ? 'tp-pos' : '')
        + _btCell('盈亏比', s.profit_factor)
        + _btCell('总收益*', s.total_return + '%', s.total_return >= 0 ? 'tp-pos' : 'tp-neg')
        + _btCell('最大回撤', s.max_drawdown + '%', 'tp-neg')
        + _btCell('夏普', s.sharpe)
        + _btCell('平均持有', s.avg_hold_days + ' 天')
        + '</div>';
      if (eq.length > 1) html += _btSpark(eq);
      const rec = ov.recent || [];
      if (rec.length) {
        html += '<div class="bt-sub">最近交易</div><table class="bt-table"><thead><tr><th>买入</th><th>卖出</th><th>进场</th><th>出场</th><th>盈亏</th><th>天</th></tr></thead><tbody>';
        rec.forEach(t => {
          const cls = t.pnl_pct >= 0 ? 'tp-pos' : 'tp-neg';
          html += '<tr><td>' + t.buy_date + '</td><td>' + t.sell_date + '</td><td>' + t.entry + '</td><td>' + t.exit + '</td>'
            + '<td class="' + cls + '">' + (t.pnl_pct >= 0 ? '+' : '') + t.pnl_pct + '%</td><td>' + t.hold_days + '</td></tr>';
        });
        html += '</tbody></table>';
      }
      html += '</div>';
    } else if (ov) {
      html += '<div class="bt-card"><div class="bt-card-title">🌙 隔夜抢仓</div><div class="bt-sample">' + (ov.msg || '无数据') + '</div></div>';
    }
    if (id && id.ok) {
      const s = id.stats || {};
      html += '<div class="bt-card"><div class="bt-card-title">🔵 日内做T · 历史回测</div>';
      html += '<div class="bt-sample">样本 ' + (id.sample ? (id.sample.from + ' ~ ' + id.sample.to + '（' + id.sample.days + ' 日 ' + (id.sample.granularity || '') + '）') : '') + '</div>';
      html += '<div class="bt-grid">'
        + _btCell('T 次数', s.trades)
        + _btCell('胜率', s.win_rate + '%', s.win_rate >= 55 ? 'tp-pos' : '')
        + _btCell('单笔均值', s.avg_pnl + '%', s.avg_pnl >= 0 ? 'tp-pos' : 'tp-neg')
        + _btCell('日均值', s.avg_day_pnl + '%', s.avg_day_pnl >= 0 ? 'tp-pos' : 'tp-neg')
        + _btCell('最大单日亏', s.max_day_loss + '%', 'tp-neg')
        + _btCell('达标率', s.target_rate + '%')
        + '</div>';
      const rd = id.recent_days || [];
      if (rd.length) {
        html += '<div class="bt-sub">最近交易日</div><table class="bt-table"><thead><tr><th>日期</th><th>日收益</th><th>次</th><th>明细（时间/盈亏）</th></tr></thead><tbody>';
        rd.forEach(d => {
          const cls = d.pnl >= 0 ? 'tp-pos' : 'tp-neg';
          const detail = (d.trades || []).map(tr => tr.t + (tr.pnl >= 0 ? '+' : '') + tr.pnl + '%').join('　');
          html += '<tr><td>' + d.date + '</td><td class="' + cls + '">' + (d.pnl >= 0 ? '+' : '') + d.pnl + '%</td><td>' + d.times + '</td><td class="bt-detail">' + detail + '</td></tr>';
        });
        html += '</tbody></table>';
      }
      html += '</div>';
    } else if (id) {
      html += '<div class="bt-card"><div class="bt-card-title">🔵 日内做T</div><div class="bt-sample">' + (id.msg || '无数据') + '</div></div>';
    }
    html += '<div class="bt-note">*总收益按每笔满仓复利估算，仅示方法；回测不含未来函数，仅供参考、不构成投资建议。</div>';
    body.innerHTML = html;
  }

  function _btCell(label, val, cls) {
    return '<div class="bt-cell"><div class="bt-cell-lbl">' + label + '</div><div class="bt-cell-val ' + (cls || '') + '">' + (val != null ? val : '--') + '</div></div>';
  }

  function _btSpark(eq) {
    const W = 240, H = 40, n = eq.length;
    const min = Math.min.apply(null, eq), max = Math.max.apply(null, eq);
    const rng = (max - min) || 1;
    const pts = eq.map((v, i) => (i / (n - 1) * W).toFixed(1) + ',' + (H - (v - min) / rng * H).toFixed(1)).join(' ');
    return '<svg class="bt-spark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none"><polyline points="' + pts + '" fill="none" stroke="#2b8a3e" stroke-width="1.5"/></svg>';
  }

  function _renderStrategyResult(mode, r) {
    const body = document.getElementById('tpStrategyBody');
    if (!body) return;
    if (!r || !r.ok) {
      body.innerHTML = '<div class="tp-strategy-hint">' + (r && r.msg || '暂无策略数据') + '</div>';
      return;
    }
    if (mode === 'overnight') {
      const tp = r.take_profit || [];
      const tagCls = (r.action === '买入' || r.action === '分批建仓') ? 'tp-st-buy' : 'tp-st-hold';
      let html = '';
      html += '<div class="tp-st-row"><span class="tp-st-tag ' + tagCls + '">' + r.action + '</span>'
            + '<span class="tp-st-score">隔夜评分 ' + (r.score != null ? r.score : '--') + '/100</span></div>';
      html += '<div class="tp-st-grid">'
            + _stCell('建议买点', r.entry != null ? r.entry.toFixed(2) : '--', r.entry_note || '')
            + _stCell('止损价', r.stop_loss != null ? r.stop_loss.toFixed(2) : '--', '跌破买入价 -2.5%')
            + _stCell('持股周期', r.hold_days || '--', '')
            + '</div>';
      html += '<div class="tp-st-tp"><b>分批止盈</b>：'
            + (tp.length >= 3
                ? ('+3% <span class="tp-st-num">' + tp[0].toFixed(2) + '</span> ｜ +5% <span class="tp-st-num">' + tp[1].toFixed(2) + '</span> ｜ +8% <span class="tp-st-num">' + tp[2].toFixed(2) + '</span>')
                : '--')
            + '</div>';
      html += _stReasons('共振命中', r.hit) + _stReasons('未命中', r.miss, true);
      html += '<div class="tp-st-risk">⚠️ ' + (r.risk || '') + '</div>';
      body.innerHTML = html;
    } else {
      const actCls = r.action === '做T买' ? 'tp-st-buy'
                   : (r.action === '做T卖' || r.action === '强制平仓') ? 'tp-st-sell' : 'tp-st-hold';
      let html = '';
      html += '<div class="tp-st-row"><span class="tp-st-tag ' + actCls + '">' + r.action + '</span>'
            + '<span class="tp-st-score">' + (r.window || '') + '</span></div>';
      html += '<div class="tp-st-grid">'
            + _stCell('T+0 买点', r.t_buy != null ? r.t_buy.toFixed(2) : '--', '回补低点')
            + _stCell('T+0 卖点', r.t_sell != null ? r.t_sell.toFixed(2) : '--', '高抛点')
            + _stCell('成本差', r.cost_diff_pct != null ? (r.cost_diff_pct >= 0 ? '+' : '') + r.cost_diff_pct + '%' : '非持仓', r.cost != null ? '成本 ' + r.cost.toFixed(2) : '')
            + '</div>';
      html += '<div class="tp-st-tp"><b>目标 / 止损</b>：'
            + '做T收益 ' + (r.target_pct != null ? (r.target_pct >= 0 ? '+' : '') + r.target_pct + '%' : '--')
            + ' ｜ 止损 ' + (r.stop_pct != null ? r.stop_pct + '%' : '--')
            + ' ｜ 强制平仓 ' + (r.force_close || '14:50')
            + ' ｜ 当日≤' + (r.max_times_per_day || 2) + ' 次</div>';
      html += _stReasons('触发条件', r.hit) + _stReasons('反向信号', r.miss, true);
      html += '<div class="tp-st-risk">⚠️ ' + (r.risk || '') + '</div>';
      body.innerHTML = html;
    }
  }
  function _stCell(label, val, note) {
    return '<div class="tp-st-cell"><div class="tp-st-cell-lbl">' + label + '</div>'
         + '<div class="tp-st-cell-val">' + val + '</div>'
         + (note ? '<div class="tp-st-cell-note">' + note + '</div>' : '') + '</div>';
  }
  function _stReasons(title, arr, weak) {
    if (!arr || !arr.length) return '';
    return '<div class="tp-st-reasons ' + (weak ? 'tp-st-weak' : '') + '"><b>' + title + '：</b>'
         + arr.map(x => '<span class="tp-st-chip">' + x + '</span>').join('') + '</div>';
  }

  // openStock 切换时同时刷新交易计划面板
  function _klineShowForStock(code, name) {
    if (code) renderStockDetail(code, name);
  }

  // 全局错误兜底：任何未捕获的报错都只在控制台警告，不阻塞后续流程（出现红屏空白就糟了）
  window.addEventListener('error', (ev) => {
    if (ev && ev.error) {
      console.warn('[wb] uncaught:', ev.error && ev.error.message ? ev.error.message : ev.error);
    }
  });
  window.addEventListener('unhandledrejection', (ev) => {
    console.warn('[wb] unhandled rejection:', ev.reason);
  });

  // 绑定导航（IIFE 内部直接调用确保仅一次）
  try { bindNav(); } catch (e) { console.warn('[wb] bindNav fail:', e && e.message); }
  // 首屏默认进入「行情看板」，让左侧自选表立刻拉一次数据
  try { switchView('dashboard'); } catch (e) { console.warn('[wb] switchView fail:', e && e.message); }
})();
