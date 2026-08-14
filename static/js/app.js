/* 股票工作台前端控制器 */
/* 版本自检：刷新时第一行打印当前是 r28-kline，如果不是说明浏览器还在用旧缓存（强制刷新 Ctrl+Shift+R / Cmd+Shift+R） */
console.log('%c[wb] app.js r28-kline loaded (K线图 + 删文字 + 持仓不自选 + 动态扫描计数)','color:#2ecc71;font-weight:bold');
if (window.__WB_VERSION__ && window.__WB_VERSION__ !== 'r28-kline') {
  console.warn('[wb] HTML/JS 版本不一致！HTML=' + window.__WB_VERSION__ + ' JS=r28-kline。请强制刷新或清缓存。');
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
  /* 把启动期错误抛到页面顶部红条（不用开 F12 也能看到） */
  function _showErrAtTop(label, info) {
    try {
      const bar = document.getElementById('errToast');
      if (!bar) return;
      bar.style.display = 'block';
      const txt = (info && info.stack) ? info.stack : String(info || '');
      bar.textContent += '[' + label + '] ' + txt.slice(0, 1500) + '\n---\n';
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
      else throw e;
    }
    if (API_BASE && !r.ok) {
      const r2 = await build("");
      if (r2.ok) { r = r2; usedBase = ""; }
    }
    if (!r.ok) throw new Error("HTTP " + r.status + " @ " + (usedBase || "同源") + url);
    return r.json();
  }
  const ACT_COLOR = {
    "强烈买入": "#c92a2a", "买入": "#e03131", "持有": "#868e96",
    "减仓": "#2f9e44", "卖出": "#2b8a3e",
  };
  const PERIOD_LABEL = { "5m": "5分", "15m": "15分", "30m": "30分", "60m": "60分", "daily": "日线", "weekly": "周线" };

  const state = {
    current: { code: "", name: "", period: "daily" },
    watchlist: [],
    watchMeta: {},   // code -> {price, change, change_pct, action, score}
    candidates: [],  // 自动优选（候选扫描）结果
    positions: [],   // [{code, name, shares, cost}]
    posAdvice: [],   // 批量持仓建议（买/卖/不动 + 操作价 + 操作量 + 行业强弱）
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
      try {
        const set5 = (id, v, cls) => { const e = document.getElementById(id); if (e) { e.textContent = v; e.classList.remove("up", "down"); if (cls) e.classList.add(cls); } };
        set5("k5Asset", fmt(asset, 0));
        set5("k5Chg", signed(todayPct, 2) + "%", todayPct > 0 ? "up" : todayPct < 0 ? "down" : "");
        set5("k5Pos", positions.length + " 只");
        set5("k5Total", signed(total, 0), total > 0 ? "up" : total < 0 ? "down" : "");
        set5("k5Signal", (state.candidates && state.candidates.length ? state.candidates.length : (window.__scanCount || 0)) + " 个");
      } catch (_) {}
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
    // 任何一步失败都不影响其余渲染（避免整页白屏）
    try { await loadWatchlist(); } catch (e) { console.warn("自选加载失败：", e); }
    try { await loadPositions(); } catch (e) { console.warn("持仓加载失败：", e); }
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
    // 每日策略：开盘判断 / 四时点快照 / 收盘复盘（30 秒刷新，后端自动补齐缺失记录）
    state.dailySnapTab = "09:30";
    try { pollDailyStrategy(); } catch (e) {}
    state.timers.push(setInterval(pollDailyStrategy, 30000));
    // 四时点快照切换
    const snapTabs = document.getElementById("dailySnapTabs");
    if (snapTabs) {
      snapTabs.addEventListener("click", e => {
        const btn = e.target.closest(".ds-btn");
        if (!btn) return;
        state.dailySnapTab = btn.dataset.t || "09:30";
        snapTabs.querySelectorAll(".ds-btn").forEach(b => b.classList.toggle("active", b === btn));
        if (state.daily) renderDailySnap(state.daily);
      });
    }
    // r27：旧 loadReview（每日复盘）已删，保留空函数避免旧引用报错；新版复盘在 review 视图按需拉取
    try { loadReview(); } catch (e) {}
    // r27：信号扫描页首次进入时预热尾盘买入法候选池
    try {
      api('GET', '/api/tail_buy').then(d => {
        if (d && d.ok) {
          const statEl = document.getElementById('tailbuyStatus');
          if (statEl) statEl.textContent = d.generated_at ? '更新于 ' + d.generated_at : '已生成';
        }
      }).catch(() => {});
    } catch (e) {}
    // 自动优选：3 秒后异步触发，不阻塞首屏（再每 10 分钟重扫）
    setTimeout(() => {
      autoScan().catch(e => console.warn("自动优选启动失败：", e));
    }, 3000);
    state.timers.push(setInterval(autoScan, 10 * 60 * 1000));
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
    if (!el) return;
    // 仅来自 state.positions（持仓股）：自动优选/自选不混入此面板，避免重复
    const list = (state.positions || []).map(p => {
      const code = p.code || "";
      const m = state.watchMeta[code] || {};
      return {
        origin: "持仓",
        code: code,
        name: p.name || m.name || code,
        action: p.action || m.action || "持有",
        score: p.advice_score != null ? p.advice_score : (p.score != null ? p.score : (m.score != null ? m.score : null)),
        price: p.price != null ? p.price : (m.price != null ? m.price : null),
        change_pct: p.change_pct != null ? p.change_pct : m.change_pct,
        track: p.track || m.track || "—",
      };
    });
    if (cnt) cnt.textContent = `共 ${list.length} 只`;
    if (!list.length) {
      el.innerHTML = '<div class="dash-monitor-empty">暂无持仓。录入或导入后这里会出现实时监控卡片。</div>';
      return;
    }
    // 按评分绝对值降序，强信号在最上
    list.sort((a, b) => Math.abs(+(b.score || 0)) - Math.abs(+(a.score || 0)));
    el.innerHTML = list.map(_renderMonitorRow).join("");
    el.querySelectorAll(".dm-row").forEach(row =>
      row.addEventListener("click", () => openStock(row.dataset.code, row.dataset.name)));
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
    state.current = { code, name: name || code, period: state.current.period || "daily" };
    // 同时切换右上方 K 线图到该股
    try { _klineShowForStock(code, name || code); } catch (e) {}
    renderStockDetail(code, name || code);
  }

  // ---------- 行情看板·个股详情（v3.1 右侧面板） ----------
  // 点击自选/搜索/持仓股时，拉实时行情 + 技术面分析，渲染评分圆环 + 2×2 技术进度条 + 三档价位
  async function renderStockDetail(code, name) {
    const body = document.getElementById("stockDetailBody");
    const title = document.getElementById("stockDetailTitle");
    const meta = document.getElementById("stockDetailMeta");
    if (!body) return;
    if (title) title.textContent = `🔍 ${name || code} · ${code}`;
    if (meta) meta.textContent = "分析中…";
    body.innerHTML = `<div class="sd-loading">正在拉取实时行情与技术面分析…</div>`;
    try {
      const [q, sig] = await Promise.all([
        api("GET", "/api/quotes?codes=" + encodeURIComponent(code)).catch(() => null),
        api("GET", "/api/signal?code=" + encodeURIComponent(code) + "&period=daily&limit=120").catch(() => null),
      ]);
      const rt = (q && q[code]) ? q[code] : null;
      if (meta) meta.textContent = rt && rt.price != null
        ? `${fmt(rt.price)}　${rt.change_pct != null ? (rt.change_pct >= 0 ? "+" : "") + fmt(rt.change_pct) + "%" : ""}`
        : "点自选查看";
      if (!sig || !sig.ok) {
        body.innerHTML = `<div class="empty-v3">${sig ? (sig.msg || "暂无分析数据") : "行情/分析接口暂不可用"}<br><span style="font-size:11px">（A股代码需带交易所前缀，如 sh600000 / sz000001）</span></div>`;
        return;
      }
      body.innerHTML = stockDetailHtml(sig, rt, name, code);
    } catch (e) {
      body.innerHTML = `<div class="empty-v3">分析加载失败：${(e && e.message) || e}</div>`;
    }
  }

  // 评分圆环（90×90 SVG）+ 2×2 技术进度条 + 三档价位，严格匹配 styles.css 的 .sd-* 结构
  function stockDetailHtml(sig, rt, name, code) {
    const action = sig.action || "持有";
    const isBuy = action.includes("买入") || action.includes("加仓");
    const isSell = action.includes("卖出") || action.includes("减仓");
    const color = isBuy ? "#e74c3c" : isSell ? "#2ecc71" : "#f59f00";
    const score = sig.score != null ? sig.score : 0;
    const scorePct = Math.max(0, Math.min(100, (score + 100) / 2));
    const price = rt && rt.price != null ? rt.price : sig.price;
    const chg = rt && rt.change_pct != null ? rt.change_pct : null;
    const chgCls = chg == null ? "" : (chg >= 0 ? "up" : "down");
    const chgTxt = chg != null ? (chg >= 0 ? "+" : "") + chg.toFixed(2) + "%" : "";

    // —— 技术进度条（v3.1 标志：KDJ / MACD / 量能 / RSI）——
    const ts = sig.tech_short || {};
    const ind = sig.indicators || {};
    const rsiObj = ind.rsi || {};
    const kdjJ = ts.kdj_j != null ? +ts.kdj_j : null;
    const kdjPct = kdjJ != null ? (kdjJ + 100) / 2 : 50;
    const kdjTxt = kdjJ != null ? ("J " + kdjJ + (ts.kdj_status ? "·" + ts.kdj_status : "")) : "J —";
    const kdjFill = kdjJ != null && kdjJ > 80 ? "red" : (kdjJ != null && kdjJ < 20 ? "green" : "green");
    const macdMap = { "红柱": 88, "红柱放": 95, "红柱缩": 72, "金叉": 88, "绿柱": 12, "绿柱放": 5, "绿柱缩": 28, "死叉": 12 };
    const macdPct = macdMap[ts.macd_status] != null ? macdMap[ts.macd_status] : 50;
    const macdTxt = ts.macd_status ? ("MACD " + ts.macd_status) : "MACD —";
    const macdFill = ts.macd_status ? (ts.macd_status.indexOf("绿") >= 0 ? "red" : "green") : "gray";
    const vol = ts.vol_ratio != null ? +ts.vol_ratio : null;
    const volPct = vol != null ? Math.max(4, Math.min(100, vol * 25)) : 50;
    const volTxt = vol != null ? ("量比 " + vol) : "量比 —";
    const volFill = vol != null ? (vol >= 1.2 ? "green" : vol <= 0.8 ? "red" : "gray") : "gray";
    const rsi = rsiObj.rsi12 != null ? +rsiObj.rsi12 : null;
    const rsiPct = rsi != null ? rsi : 50;
    const rsiTxt = rsi != null ? ("RSI " + rsi) : "RSI —";
    const rsiFill = rsi != null ? (rsi > 70 || rsi < 30 ? "red" : "green") : "gray";

    // —— 三档价位（v3.1 标志：建仓 / 止损 / 目标）——
    const tl = sig.tight || {};
    const buy = tl.buy != null ? fmt(tl.buy, 2) : "--";
    const sl = tl.stop_loss != null ? fmt(tl.stop_loss, 2) : "--";
    const tp = tl.take_profit != null ? fmt(tl.take_profit, 2) : "--";

    // 评分圆环 SVG（r=40, 周长≈251.3）
    const C = 251.327, off = C * (1 - scorePct / 100);
    const ring = `<svg viewBox="0 0 90 90" width="90" height="90">
      <circle cx="45" cy="45" r="40" fill="none" stroke="#2a2a2a" stroke-width="8"/>
      <circle cx="45" cy="45" r="40" fill="none" stroke="${color}" stroke-width="8" stroke-linecap="round"
        stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 45 45)"/>
    </svg>`;

    // 今日做T参考
    const today = sig.today || {};
    const todayHtml = (today.buy != null && today.sell != null)
      ? `<div class="sd-today">📅 今日做T：涨到 <b class="up">${fmt(today.sell, 2)}</b> 卖 / 跌到 <b class="down">${fmt(today.buy, 2)}</b> 买（开盘 ${fmt(today.open, 2)}）</div>`
      : "";

    // 技术研判要点
    const reasons = (sig.reasons || []).slice(0, 6).map(r => {
      const pc = r.pts > 0 ? "pos" : r.pts < 0 ? "neg" : "";
      return `<li><span class="pts ${pc}">${r.pts > 0 ? "+" : ""}${r.pts}</span>${r.text}</li>`;
    }).join("");

    const bar = (name, pct, txt, fill) =>
      `<div class="sd-bar"><span class="sd-bar-name">${name}</span>` +
      `<div class="sd-bar-track"><i class="sd-bar-fill ${fill}" style="width:${Math.max(0, Math.min(100, pct))}%"></i></div>` +
      `<span class="sd-bar-val">${txt}</span></div>`;

    return `
    <div class="sd-detail">
      <div class="sd-head">
        <div>
          <div class="sd-name">${name || code}<span class="sd-code">${code}</span></div>
          <div class="sd-price">${price != null ? fmt(price) : "--"}<span class="sd-chg ${chgCls}">${chgTxt}</span></div>
        </div>
        <span class="sd-action-badge" style="background:${color}">${action}</span>
      </div>

      <div class="sd-signal-row">
        <div class="sd-ring">${ring}<div class="sd-ring-text"><div class="sd-ring-num" style="color:${color}">${score > 0 ? "+" : ""}${score}</div><div class="sd-ring-label">综合评分</div></div></div>
        <div class="sd-signal-info">
          <div class="sd-signal-act" style="color:${color}">${action}</div>
          <div class="sd-signal-desc">综合评分 ${score > 0 ? "+" : ""}${score}　·　偏向 ${score > 0 ? "多头" : score < 0 ? "空头" : "震荡"}</div>
        </div>
      </div>

      <div class="sd-section-title">技术面 · 短线动能</div>
      <div class="sd-bars">
        ${bar("KDJ", kdjPct, kdjTxt, kdjFill)}
        ${bar("MACD", macdPct, macdTxt, macdFill)}
        ${bar("量能", volPct, volTxt, volFill)}
        ${bar("RSI", rsiPct, rsiTxt, rsiFill)}
      </div>

      <div class="sd-section-title">三档价位</div>
      <div class="sd-levels">
        <div class="sd-lev"><div class="sd-lev-name">建仓</div><div class="sd-lev-val green">${buy}</div></div>
        <div class="sd-lev"><div class="sd-lev-name">止损</div><div class="sd-lev-val">${sl}</div></div>
        <div class="sd-lev"><div class="sd-lev-name">目标</div><div class="sd-lev-val green">${tp}</div></div>
      </div>

      ${todayHtml}

      <div class="sd-section-title">技术研判</div>
      <ul class="sd-reasons">${reasons || "<li>暂无研判要点</li>"}</ul>
    </div>`;
  }

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
    // 视图进入时按需刷新数据
    if (name === 'dashboard') {
      try { renderSelfStocks(); } catch (e) { console.warn('[wb] dashboard render:', e && e.message); }
    } else if (name === 'scan') {
      try { renderScanView(); } catch (e) { console.warn('[wb] scan render:', e && e.message); }
      try { renderTailBuy(); } catch (e) { console.warn('[wb] tailbuy render:', e && e.message); }
    } else if (name === 'positions') {
      // 进入持仓与仓位视图时，主动刷新一次持仓表（r27 删了 AI 建议 / 尾盘策略 / 每日复盘）
      try {
        if (state.posAdvice && state.posAdvice.length) {
          renderPosTable(state.posAdvice);
        } else {
          renderAccount();
        }
      } catch (e) { console.warn('positions 视图刷新失败：', e); }
    } else if (name === 'review') {
      // r27：进入复盘视图，主动加载今日预测 + 历史 + 准确率统计
      try { renderReview(); } catch (e) { console.warn('[wb] review render:', e && e.message); }
    }
  }

  function bindNav() {
    document.querySelectorAll('#sbNav li').forEach(li => {
      li.addEventListener('click', () => switchView(li.dataset.view));
    });
  }

  // 简易信号扫描双列（适配 v3.1 详情页：买入候选红色 / 卖出候选绿色）
  function renderScanView() {
    const buyEl  = document.getElementById('scanBuyList');
    const sellEl = document.getElementById('scanSellList');
    if (!buyEl || !sellEl) return;
    const paint = (msg) => {
      buyEl.innerHTML  = `<div class="empty-v3">${msg}</div>`;
      sellEl.innerHTML = `<div class="empty-v3">${msg}</div>`;
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
      // r28：把头部"5"改成动态真实命中数
      const buyCntEl  = document.getElementById('scanBuyCount');
      const sellCntEl = document.getElementById('scanSellCount');
      if (buyCntEl)  buyCntEl.textContent  = buyAll.length;
      if (sellCntEl) sellCntEl.textContent = sellAll.length;
      buyEl.innerHTML  = (buy.length  ? headerHtml(buyAll.length) + buy.map(rowHtml).join('')  : '<div class="empty-v3">暂无买入候选</div>');
      sellEl.innerHTML = (sell.length ? headerHtml(sellAll.length) + sell.map(rowHtml).join('') : '<div class="empty-v3">暂无卖出候选</div>');
    }).catch(e => paint('信号扫描失败：' + (e.message || e)));
  }

  // ========== r27 尾盘买入法 ==========
  // 每天 14:50~14:58 推荐 2-3 只大A纯主板（沪 60/601/603/605；深 000/001/002），
  // 排除创业板（30x）、北交所（83x/87x/43x）、可转债等；策略详见 HTML 注释
  async function renderTailBuy(forceRefresh) {
    const pickEl = document.getElementById('tailbuyPickList');
    const poolEl = document.getElementById('tailbuyPoolList');
    const pickCnt = document.getElementById('tailbuyPickCount');
    const poolCnt = document.getElementById('tailbuyPoolCount');
    const statEl = document.getElementById('tailbuyStatus');
    if (!pickEl || !poolEl) return;
    pickEl.innerHTML = '<div class="tailbuy-empty">加载中…（扫全主板约 5-10 秒）</div>';
    poolEl.innerHTML = '<div class="tailbuy-empty">加载中…</div>';
    if (statEl) statEl.textContent = '运行中…';
    try {
      const url = '/api/tail_buy' + (forceRefresh ? '?force=1' : '');
      const data = await api('GET', url);
      if (!data || !data.ok) throw new Error((data && data.error) || '无响应');
      const picks = data.picks || [];
      const pool = data.pool || [];
      if (pickCnt) pickCnt.textContent = picks.length;
      if (poolCnt) poolCnt.textContent = pool.length;
      if (statEl) statEl.textContent = data.generated_at ? '更新于 ' + data.generated_at : '已生成';
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
      pickEl.innerHTML = picks.length
        ? picks.map(r => card(r, true)).join('')
        : '<div class="tailbuy-empty">暂无达标（可能不在 14:50 后或主板无满足全部条件的票）</div>';
      poolEl.innerHTML = pool.length
        ? pool.slice(0, 30).map(r => card(r, false)).join('')
        : '<div class="tailbuy-empty">候选池为空</div>';
      // 点击卡片打开个股详情
      [pickEl, poolEl].forEach(box => {
        box.querySelectorAll('.tailbuy-card').forEach(c => {
          c.addEventListener('click', () => openStock(c.dataset.code, c.dataset.code));
        });
      });
    } catch (e) {
      pickEl.innerHTML = `<div class="tailbuy-empty">尾盘买入法加载失败：${(e && e.message) || e}<br><span style="font-size:11px">首次会缓存股票池，1-2 分钟后重试</span></div>`;
      poolEl.innerHTML = '';
      if (statEl) statEl.textContent = '加载失败';
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
  function bindReviewButtons() {
    const btnP = document.getElementById('rvPredictBtn');
    const btnC = document.getElementById('rvCheckBtn');
    const refresh = document.getElementById('tailbuyRefresh');
    if (btnP) btnP.addEventListener('click', async () => {
      btnP.disabled = true; btnP.textContent = '生成中…';
      try {
        const r = await api('POST', '/api/review/predict', {});
        toast(r && r.ok ? '已生成今日预测（' + (r.count || 0) + ' 只）' : '生成失败：' + (r && r.error || '未知'));
        renderReview();
      } catch (e) { toast('生成失败：' + (e && e.message || e)); }
      btnP.disabled = false; btnP.textContent = '立即生成今日预测';
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
    if (refresh) refresh.addEventListener('click', () => renderTailBuy(true));
  }

  // ========== r28 行情看板·短线 K 线图 ==========
  let _klineChart = null;       // StockChart 实例
  let _klineState = { code: "", name: "", period: "5m", timer: null };

  function bindKline() {
    const cv = document.getElementById('klineCanvas');
    const tip = document.getElementById('klineTooltip');
    if (!cv) return;
    try {
      if (window.StockChart) _klineChart = new window.StockChart(cv, tip);
    } catch (e) { console.warn('[wb] StockChart init:', e && e.message); return; }

    // 周期按钮
    document.querySelectorAll('.kline-period').forEach(b => {
      b.addEventListener('click', () => {
        document.querySelectorAll('.kline-period').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        _klineState.period = b.dataset.p || "5m";
        loadKline(_klineState.code, _klineState.name, _klineState.period);
      });
    });

    // 默认显示第一个持仓股的 5 分钟 K 线
    const first = (state.positions || [])[0];
    if (first) {
      loadKline(first.code, first.name, _klineState.period);
    } else {
      const meta = document.getElementById('klineMeta');
      if (meta) meta.textContent = '暂无持仓';
    }

    // 30 秒自动刷新（短线操作要求及时）
    if (_klineState.timer) clearInterval(_klineState.timer);
    _klineState.timer = setInterval(() => {
      if (_klineState.code) loadKline(_klineState.code, _klineState.name, _klineState.period, true);
    }, 30000);
  }

  async function loadKline(code, name, period, isRefresh) {
    if (!code || !window.StockChart || !_klineChart) return;
    _klineState.code = code;
    _klineState.name = name || code;
    _klineState.period = period || "5m";
    const meta = document.getElementById('klineMeta');
    const title = document.getElementById('klineTitle');
    if (title) title.textContent = `📈 短线 K 线 · ${_klineState.name} · ${period}`;
    if (meta && !isRefresh) meta.textContent = '加载中…';
    try {
      const r = await api('GET', '/api/kline?code=' + encodeURIComponent(code) + '&period=' + _klineState.period + '&limit=120');
      if (!r || !r.bars || !r.bars.length) {
        if (meta) meta.textContent = '暂无数据';
        return;
      }
      // 短线图：关闭 BOLL/KDJ/RSI，只显示 MA + 成交量 + MACD（缩短布局）
      const opts = { showBoll: false, showKdj: false, showRsi: false, showMacd: true };
      _klineChart.setData(r.bars, r.indicators || null, opts);
      if (meta) {
        const last = r.bars[r.bars.length - 1];
        const chg = last && last.close ? ((last.close - last.open) / last.open * 100).toFixed(2) : '--';
        meta.textContent = `共 ${r.bars.length} 根 · 最新 ${last && last.close ? last.close.toFixed(2) : '--'} (${chg}%) · ${new Date().toLocaleTimeString()}`;
      }
    } catch (e) {
      if (meta) meta.textContent = '加载失败：' + (e && e.message || e);
    }
  }

  // openStock 切换时同时切换 K 线图
  function _klineShowForStock(code, name) {
    if (_klineChart && code) loadKline(code, name || code, _klineState.period);
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
