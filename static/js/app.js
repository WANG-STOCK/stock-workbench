/* 股票工作台前端控制器 */
(function () {
  const $ = (s) => document.querySelector(s);
  let API_BASE = localStorage.getItem("wb_api_base") || "";
  const api = async (method, url, body) => {
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
      // API_BASE 失效（地址改过/服务迁移）→ 自动回退到同源相对路径
      if (API_BASE) { r = await build(""); usedBase = ""; }
      else throw e;
    }
    // 设了 API_BASE 但返回非 2xx（如 404/500，多半是地址不对），再试一次同源
    if (API_BASE && !r.ok) {
      const r2 = await build("");
      if (r2.ok) { r = r2; usedBase = ""; }
    }
    if (!r.ok) throw new Error("HTTP " + r.status + " @ " + (usedBase || "同源") + url);
    return r.json();
  };
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
      if (!d || !d.ok) return;
      const positions = d.positions || [];
      state.posAdvice = positions;

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
      computeSignalsForWatchlist();   // 自选股也注入当日行业资金流
      // 同时刷新今日已成交明细（不让"刚录入的记录"看起来消失）
      loadTradeLog();
      // 调试：把首次大开销暴露给用户，提示自动被后续覆盖
      if (took > 3000 && !state._slowNoticeShown) {
        state._slowNoticeShown = true;
        toast("首次加载 " + took + "ms（板块+指标冷启），后续 5s 缓存秒回", true);
      }
    } catch (e) { /* ignore */ }
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
    // 横向布局：每只持仓 = 一行 <tr>，5 列对齐：股票 / 评分 / 操作 / 今日预估+板块 / 偏T方案
    // 整个界面"对齐不要歪歪扭扭"。
    el.innerHTML = '<table class="ai-table">' +
      '<thead><tr>' +
        '<th class="ai-c-name" style="min-width:115px">股票</th>' +
        '<th class="ai-c-score" style="width:60px">评分</th>' +
        '<th class="ai-c-action" style="width:60px">操作</th>' +
        '<th class="ai-c-fc" style="min-width:230px">今日预估 + 板块</th>' +
        '<th class="ai-c-tp" style="min-width:240px">偏T方案（实时）</th>' +
      '</tr></thead>' +
      '<tbody>' + sorted.map(_aiCardHtml).join("") + '</tbody>' +
      '</table>';
  }

  // AI 卡片：横向表格一行（5 列：股票 / 评分 / 操作 / 今日预估+板块 / 偏T方案）
  // 核心：跟实盘走 + 利润最大化 —— 偏T方案的 buy/sell 给 ATR 宽度，不做"±0.8% 紧价"。
  function _aiCardHtml(p) {
    const action = p.action || "不动";
    const label = p.action_label || (action === "买入" ? "加仓" : action === "卖出" ? "减仓" : "持有");
    const score = p.advice_score != null ? p.advice_score : 0;
    const cls = action === "买入" || action === "强烈买入" ? "ai-buy" : action === "卖出" ? "ai-sell" : "ai-hold";
    const strong = action === "强烈买入" || action === "买入";
    // 行 class 控制整体底色（买=绿、卖=红、持有=黄）
    const rowCls = action === "买入" || action === "强烈买入" ? "ai-row-buy" :
                   action === "卖出" ? "ai-row-sell" : "ai-row-hold";

    // 实时动态信号标签（基于盘中 5min 分时）
    const liveHtml = _liveHint(p);

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
    const basisHtml = (fc.basis || []).filter(Boolean).slice(0, 4)
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

    // 偏T方案（实时，跟实盘走）
    const tpPlan = _tpPlan(p, fcTrend);

    return '<tr class="' + rowCls + (strong ? ' ai-strong' : '') + '">' +
      // ① 股票
      '<td class="ai-c-name">' +
        '<div class="name-line"><b>' + (p.name || p.code) + '</b><i class="code-mini">' + p.code + '</i></div>' +
        '<div class="price-line">' +
          '<span class="ss-px"><b>' + pxTxt + '</b></span>' +
          (changeTxt ? '<span class="' + changeCls + '" style="font-size:11px;margin-left:4px">' + changeTxt + '</span>' : '') +
        '</div>' +
        (liveHtml || '') +
      '</td>' +
      // ② 评分
      '<td class="ai-c-score ' + cls + '">' + (score > 0 ? '+' : '') + score + '</td>' +
      // ③ 操作
      '<td class="ai-c-action">' +
        '<span class="ai-action-pill ' + cls + '">' + label + '</span>' +
        (p.op_qty && p.op_qty > 0 ? '<div class="op-qty-mini"><b>' + p.op_qty + '</b>股</div>' : '') +
        (p.op_price ? '<div class="op-price-mini">' + fmt(p.op_price, 2) + '</div>' : '') +
      '</td>' +
      // ④ 今日预估 + 板块
      '<td class="ai-c-fc">' +
        '<div class="fc-head"><span class="fc-trend ' + fcCls + '">' + fcTrend + ' </span>' +
          '<span class="fc-pct ' + fcCls + '">' + (fcPct >= 0 ? '+' : '') + fcPct.toFixed(2) + '%</span></div>' +
        (basisHtml ? '<ul class="fc-basis">' + basisHtml + '</ul>' : '') +
        // 高低预测（利润最大化）：今天预估能卖到的最高/能买到的最低
        ((fcHi || fcLo) ? (
          '<div class="fc-band">' +
            '<span class="fc-band-hi" title="预估今天能卖在的最高价">高 <b>' + (fcHi ? fmt(fcHi, 2) : '—') + '</b></span>' +
            '<span class="fc-band-mid">·</span>' +
            '<span class="fc-band-lo" title="预估今天能买到的最低价">低 <b>' + (fcLo ? fmt(fcLo, 2) : '—') + '</b></span>' +
          '</div>'
        ) : '') +
        // 板块块（合并到今日预估下方）
        '<div class="ai-sec-block">' +
          '<div class="sec-row1"><span class="sec-name">' + secName + '</span><span class="sec-pct ' + secPctCls + '">' + secPctTxt + '</span></div>' +
          '<div class="sec-row2">' + secFundTxt + (secFundTxt && upRatioTxt ? '　' : '') + upRatioTxt + '</div>' +
        '</div>' +
      '</td>' +
      // ⑤ 偏T方案（实时 ATR 宽度）
      '<td class="ai-c-tp">' + _tpHtml(tpPlan) + '</td>' +
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
    // 任何一步失败都不影响其余渲染（避免整页白屏）
    try { await loadWatchlist(); } catch (e) { console.warn("自选加载失败：", e); }
    try { await loadPositions(); } catch (e) { console.warn("持仓加载失败：", e); }
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
    // 尾盘策略：30 秒刷新（低频，尾盘汇总减仓/埋伏结论）
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
    // 每日复盘：开盘后自动记录持仓建议/最高/收盘，用于复盘准确率
    try { loadReview(); } catch (e) {}
    state.timers.push(setInterval(loadReview, 60000));
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

  function renderSelfStocks() {
    const el = $("#selfStocks");
    if (!el) return;
    const list = buildSelfList();
    const cnt = $("#selfCount");
    if (cnt) cnt.textContent = `共 ${list.length} 只`;
    if (!list.length) {
      el.innerHTML = `<div class="signal-empty">自动优选中…（首次约 1 分钟扫描成长池）</div>`;
      return;
    }
    el.innerHTML = list.map(it => {
      const act = it.action || "—";
      const strong = act === "强烈买入";
      const cls = _ssActionClass(act);
      const c = ACT_COLOR[act] || "#868e96";
      const pxTxt = it.price != null
        ? `<span class="ss-px ${chgClass(it.change_pct)}">${fmt(it.price)}</span><span class="ss-chg ${chgClass(it.change_pct)}">${it.change_pct != null ? (it.change_pct >= 0 ? "+" : "") + fmt(it.change_pct) + "%" : ""}</span>`
        : `<span class="ss-px">--</span>`;
      const scoreTxt = it.score != null ? `综合 <b>${it.score}</b>` : "";
      const sec = [];
      if (it.track) sec.push(`<span class="ss-track">${it.track}</span>`);
      if (it.sector_trend != null) sec.push(`<span class="${it.sector_trend >= 0 ? 'up' : 'down'}">${it.sector_trend >= 0 ? '↑' : '↓'}${fmt(it.sector_trend)}%</span>`);
      if (it.sector_fund != null) sec.push(`<span class="${it.sector_fund >= 0 ? 'up' : 'down'}">主力${it.sector_fund >= 0 ? '+' : ''}${fmt(it.sector_fund)}亿</span>`);
      const buyTxt = it.buy_price != null ? `荐买 <b class="ss-buy-price">${fmt(it.buy_price)}</b>` : "";
      const sellTxt = it.sell_price != null ? `卖 <b class="ss-sell-price">${fmt(it.sell_price)}</b>` : "";
      const gradeTxt = it.fund_grade ? `<span class="ss-grade g-${it.fund_grade}">${it.fund_grade}</span>` : "";
      const peTxt = it.pe != null ? `PE ${it.pe}` : "";
      // 操作按钮：优选可加自选；自选可移除
      const actionBtn = it.origin === "自选"
        ? `<span class="ss-del" data-code="${it.code}" title="移除自选">✕</span>`
        : (_inWatch(it.code) ? `<span class="ss-added">已加</span>` : `<span class="ss-add" data-code="${it.code}" data-name="${it.name}" data-price="${it.price != null ? it.price : ''}" data-buy="${it.buy_price != null ? it.buy_price : ''}">+自选</span>`);
      return `<div class="ss-row ${cls}${strong ? ' ss-strong' : ''}" data-code="${it.code}" data-name="${it.name}">
        <div class="ss-top">
          <span class="ss-act" style="background:${c}">${strong ? '🔥' : ''}${act}</span>
          <span class="ss-name">${it.name}<i>${it.code}</i></span>
          <span class="ss-tag tag-${it.origin}">${it.origin}</span>
          ${actionBtn}
        </div>
        <div class="ss-mid">
          ${pxTxt}
          <span class="ss-score">${scoreTxt}</span>
          <span class="ss-sector">${sec.join("　")}</span>
        </div>
        <div class="ss-bot">${buyTxt}${sellTxt ? "　" + sellTxt : ""}${gradeTxt}${peTxt ? "　" + peTxt : ""}</div>
      </div>`;
    }).join("");
    // 绑定：优选点击加自选；自选点击移除
    el.querySelectorAll(".ss-add").forEach(b =>
      b.addEventListener("click", async (e) => {
        e.stopPropagation();
        await addToWatch(b.dataset.code, b.dataset.name, b.dataset.price || null, b.dataset.buy || null);
      }));
    el.querySelectorAll(".ss-del").forEach(b =>
      b.addEventListener("click", async (e) => {
        e.stopPropagation();
        state.watchlist = state.watchlist.filter(w => w.code !== b.dataset.code);
        delete state.watchMeta[b.dataset.code];
        await saveWatchlist(); renderSelfStocks();
      }));
    el.querySelectorAll(".ss-row").forEach(row =>
      row.addEventListener("click", () => {
        if (row.querySelector(".ss-add, .ss-del")) return;
        openStock(row.dataset.code, row.dataset.name);
      }));
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
    // K线视图已移除，转为加入自选（避免 console error 让用户茫然）
    state.current = { code, name: name || code, period: state.current.period || "daily" };
    addToWatchFromSearch(code, name || code);
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
})();
