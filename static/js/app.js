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
    positions: [],   // [{code, name, shares, cost}]
    posAdvice: [],   // 批量持仓建议（买/卖/不动 + 操作价 + 操作量 + 行业强弱）
    lastKline: null,
    timers: [],
  };

  let chart;

  function toast(msg, sec = 3) {
    const t = $("#toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), sec * 1000);
  }

  function fmt(n, d = 2) { return n == null ? "--" : Number(n).toFixed(d); }
  function chgClass(v) { return v > 0 ? "up" : v < 0 ? "down" : ""; }

  // ---------- 初始化 ----------
  async function init() {
    // 图表初始化失败不应拖垮整个页面
    try { chart = new StockChart($("#chart"), $("#tooltip")); }
    catch (e) { console.warn("图表初始化失败：", e); chart = null; }

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

    bindEvents();
    // 还原现金（持仓汇总条可编辑，localStorage 持久化）
    const _cash = localStorage.getItem("wb_cash");
    if (_cash != null) $("#cashInput").value = _cash;
    // 任何一步失败都不影响其余渲染（避免整页白屏）
    try { await loadWatchlist(); } catch (e) { console.warn("自选加载失败：", e); }
    try { await loadPositions(); } catch (e) { console.warn("持仓加载失败：", e); }
    try { setupWeights(cfg); } catch (e) {}
    try {
      $("#availCapital").value = (cfg.available_capital != null ? cfg.available_capital : 100000);
      $("#apiBase").value = API_BASE;
      $("#tdxPath").value = cfg.tdx_path || "";
      $("#tdxPathTip").textContent = cfg.tdx_available
        ? "已启用本地数据：" + cfg.tdx_path
        : "填好后，选股下拉选「通达信全市场」即可扫描全部 A 股日线（需先在通达信下载日线数据）。";
    } catch (e) {}
    startClock();
    startMonitor();
    startLiveView();
    state.timers.push(setInterval(loadPositionAdvice, 10000));
    // 盘中实时建议：5 秒高频刷新（解决"拉升到6个点跌到4个点该不该卖"的分时判断）
    pollIntraday();
    state.timers.push(setInterval(pollIntraday, 8000));
    // 尾盘策略：30 秒刷新（低频，尾盘汇总减仓/埋伏结论）
    try { loadTailStrategy(); } catch (e) {}
    state.timers.push(setInterval(loadTailStrategy, 30000));
    // 盘中分时周期切换（1分钟 / 5分钟）
    const periodBox = document.getElementById("intradayPeriods");
    if (periodBox) {
      periodBox.addEventListener("click", e => {
        const btn = e.target.closest(".ip-btn");
        if (!btn) return;
        intradayPeriod = btn.dataset.period || "1m";
        periodBox.querySelectorAll(".ip-btn").forEach(b => b.classList.toggle("active", b === btn));
        _intradayBusy = false;  // 允许立即按新周期刷新
        pollIntraday();
      });
    }
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
    // 调试与共享链接：?code=sh600105 自动打开该股；?demo=1 同时跑一次候选扫描
    const _qp = new URLSearchParams(location.search);
    const _demoCode = _qp.get("code");
    if (_demoCode) {
      setTimeout(() => openStock(_demoCode, _qp.get("name") || ""), 700);
    }
    if (_qp.get("demo") === "scan") {
      setTimeout(() => { const s = $("#scopeSelect"); s.value = "candidate"; runScreener(); }, 1200);
    }
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
            openStock(el.dataset.code, el.dataset.name);
            $("#searchInput").value = ""; $("#searchResults").innerHTML = "";
          }));
      }, 250);
    });

    // 周期
    $("#periodBtns").querySelectorAll("button").forEach(b =>
      b.addEventListener("click", () => {
        $("#periodBtns").querySelectorAll("button").forEach(x => x.classList.remove("active"));
        b.classList.add("active");
        state.current.period = b.dataset.period;
        if (state.current.code) loadKline();
      }));

    // 指标开关（HTML 已精简为 BOLL/MACD/KDJ 三项，无 RSI）
    ["tgBoll", "tgMacd", "tgKdj"].forEach(id =>
      $("#" + id).addEventListener("change", () => {
        if (state.lastKline) chart.setData(state.lastKline.bars, state.lastKline.indicators, toggleOpts());
      }));

    $("#refreshBtn").addEventListener("click", () => { if (state.current.code) loadKline(); });
    $("#addCurrent").addEventListener("click", addCurrentToWatch);
    $("#refreshSignals").addEventListener("click", computeSignals);
    $("#scanBtn").addEventListener("click", runScreener);
    $("#availCapital").addEventListener("change", async () => {
      const v = parseFloat($("#availCapital").value || "100000");
      await api("POST", "/api/config", { available_capital: v }).catch(() => {});
      toast("可用资金已设为 ¥" + v.toLocaleString("zh-CN"));
    });
    $("#rebuildBtn").addEventListener("click", rebuildUniverse);
    $("#advBtn").addEventListener("click", recomputeAdvice);

    // 持仓台账
    $("#addPosBtn").addEventListener("click", addPosition);
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

    // 现金（持仓汇总条）：编辑即持久化 + 触发重新测算（防抖，避免每个字都打后端）
    let _cashT;
    const onCash = () => {
      const v = $("#cashInput").value;
      localStorage.setItem("wb_cash", v);
      clearTimeout(_cashT);
      _cashT = setTimeout(() => loadPositionAdvice(), 500);
    };
    $("#cashInput").addEventListener("input", onCash);
    $("#cashInput").addEventListener("change", onCash);
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
    const ul = $("#watchlist");
    const items = state.watchlist || [];
    if (!items.length) {
      ul.innerHTML = `<li class="watch-empty" style="text-align:center;color:var(--muted);padding:14px;font-size:12px">暂无自选，点「+加当前」或扫描后「加自选」</li>`;
      return;
    }
    ul.innerHTML = items.map(w => {
      const code = w.code;
      const m = state.watchMeta[code] || {};
      const cur = state.current.code === code ? "active" : "";
      const act = m.action || "";
      const dot = act ? `<span class="sig-dot" style="background:${ACT_COLOR[act] || '#ccc'}"></span>` : `<span class="sig-dot" style="background:#ddd"></span>`;
      const px = m.price != null ? `<div class="wi-price"><div class="px ${chgClass(m.change)}">${fmt(m.price)}</div><div class="chg ${chgClass(m.change)}">${m.change_pct != null ? (m.change_pct >= 0 ? "+" : "") + fmt(m.change_pct) + "%" : ""}</div></div>` : `<div class="wi-price"></div>`;
      // 增长：现价 vs 添加时价格
      let grow = "--";
      if (m.price != null && w.add_price != null && w.add_price > 0) {
        const gp = (m.price / w.add_price - 1) * 100;
        grow = `<span class="${gp >= 0 ? 'up' : 'down'}">${gp >= 0 ? '+' : ''}${gp.toFixed(1)}%</span>`;
      }
      const addTime = w.add_time ? w.add_time.slice(5, 16).replace("T", " ") : "--";
      const addPrice = w.add_price != null ? fmt(w.add_price) : "--";
      const recBuy = w.scan_buy != null ? `<b style="color:#2b8a3e">${fmt(w.scan_buy)}</b>` : "--";
      return `<li class="watch-item ${cur}" data-code="${code}">${dot}${px}
        <div class="wi-name"><div class="nm">${m.name || w.name || code}</div><div class="cd">${code}</div></div>
        <div class="wi-meta">
          <div>添加 <b>${addTime}</b></div>
          <div>添加价 <b>${addPrice}</b></div>
          <div>增长 ${grow}</div>
          <div>荐买 ${recBuy}</div>
        </div>
        <span class="wi-del" data-code="${code}">✕</span></li>`;
    }).join("");
    ul.querySelectorAll(".watch-item").forEach(el => {
      const code = el.dataset.code;
      el.addEventListener("click", (e) => {
        if (e.target.classList.contains("wi-del")) return;
        const m = state.watchMeta[code] || {};
        openStock(code, m.name || code);
      });
    });
    ul.querySelectorAll(".wi-del").forEach(el =>
      el.addEventListener("click", async (e) => {
        e.stopPropagation();
        state.watchlist = state.watchlist.filter(w => w.code !== el.dataset.code);
        delete state.watchMeta[el.dataset.code];
        await saveWatchlist(); renderWatchlist();
      }));
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
    state.current = { code, name: name || code, period: state.current.period || "daily" };
    $("#curName").textContent = name || code;
    $("#curCode").textContent = code;
    // 自动用持仓台账填「持仓(股)」
    const held = (state.positions.find(p => p.code === code) || {}).shares || 0;
    $("#holdInput").value = held;
    state.watchlist.forEach(c => document.querySelectorAll(`.watch-item[data-code="${c}"]`).forEach(e => e.classList.remove("active")));
    document.querySelectorAll(`.watch-item[data-code="${code}"]`).forEach(e => e.classList.add("active"));
    await loadKline();
  }

  async function loadKline() {
    const { code, period } = state.current;
    const lim = period === "daily" ? 300 : period === "weekly" ? 200 : 240;
    const data = await api("GET", `/api/kline?code=${code}&period=${period}&limit=${lim}`);
    state.lastKline = data;
    chart.setData(data.bars, data.indicators, toggleOpts());
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
      return `<div class="cand-row" data-code="${r.code}" data-name="${r.name}" style="padding:8px 4px;border-bottom:1px solid #eee;cursor:pointer">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span class="tag" style="background:${c}">${r.action}</span>
          <span style="font-weight:600">${r.name}</span><span style="color:#888;font-size:11px">${r.code}</span>
          <span style="color:#666;font-size:12px">· ${r.track}</span>
          <span style="color:#666;font-size:12px">· 赛道 ${r.sector_trend != null ? (r.sector_trend >= 0 ? "↑" : "↓") + fmt(r.sector_trend) + "%" : "—"}${r.sector_fund != null ? "　主力" + (r.sector_fund >= 0 ? "+" : "") + r.sector_fund.toFixed(1) + "亿" : ""}</span>
          <span style="margin-left:auto;font-size:12px">综合 <b style="font-size:14px">${r.combined}</b> <span style="color:#999">（技${r.tech_score}/基${r.fund_score}${r.expect_score != null ? "/预期" + r.expect_score : ""}）</span></span>
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
          ${peTxt} ${tgtTxt} ${expTxt}
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
      const cap = $("#availCapital").value || 100000;
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
    el.innerHTML = `<div class="scan-hint">策略：${data.strategy_label} · 命中 ${data.results.length} 只（按评分降序）</div>` + renderScanRows(data.results);
    bindScanRows(el);
  }

  async function pollScan(strategy) {
    const el = $("#screenerResults");
    try {
      const st = await api("GET", "/api/scan_status");
      const total = st.total || 1;
      const pct = Math.min(100, Math.round((st.done / total) * 100));
      const isCand = st.scope === "candidate";
      const rows = isCand ? renderCandidateRows(st.results) : renderScanRows(st.results);
      const hint = st.results.length
        ? (isCand
            ? `<div class="scan-hint">十五五成长池（纯主板 ${st.total} 只）· 命中 ${st.results.length} 只（综合分=技术50%+基本面40%+赛道趋势10%，按综合分降序）</div>`
            : `<div class="scan-hint">策略：${strategy} · 已命中 ${st.results.length} 只（实时更新，按评分降序）</div>`)
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
      const basis = p.op_basis ? `📐 价格逻辑：${p.op_basis}（随股价移动，不再死板）` : "";
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
  async function addPosition() {
    const code = $("#posCode").value.trim();
    const shares = parseInt($("#posShares").value || "0", 10);
    if (!code) { toast("请输入代码"); return; }
    if (!shares || shares <= 0) { toast("请输入股数"); return; }
    const cost = parseFloat($("#posCost").value || "0") || 0;
    let name = code;
    const rt = await api("GET", "/api/quotes?codes=" + code).catch(() => ({}));
    if (rt[code] && rt[code].name) name = rt[code].name;
    await api("POST", "/api/positions", { code, name, shares, cost });
    $("#posCode").value = ""; $("#posShares").value = ""; $("#posCost").value = "";
    await loadPositions();
    // 若当前正看这只，刷新建议里的持仓
    if (state.current.code === code) { $("#holdInput").value = shares; await recomputeAdvice(); }
    toast(`已新增：${name} ${shares}股×¥${cost}（已同步云端主源）`);
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
  // 持仓批量建议：一次拉全持仓的 买/卖/不动 + 操作价 + 操作量 + 行业强弱 + 实时价
  // 每 10 秒自动刷新（页面自动跳动，无需手动刷新）
  async function loadPositionAdvice() {
    const cash = parseFloat($("#cashInput").value || "100000") || 0;
    try {
      const data = await api("GET", "/api/positions_advice?capital=" + cash);
      if (!data || !data.ok) return;
      state.posAdvice = data.positions || [];
      $("#posMarketValue").textContent = "¥" + (data.market_value != null
        ? data.market_value.toLocaleString("zh-CN", { maximumFractionDigits: 0 }) : "--");
      $("#posTotalValue").textContent = "¥" + (data.total_value != null
        ? data.total_value.toLocaleString("zh-CN", { maximumFractionDigits: 0 }) : "--");
      renderPositions();
      renderInlineIntraday();
      renderIntradayList();
    } catch (e) { /* 网络抖动忽略 */ }
  }
  // 在每只持仓卡片下方内联一份分时建议（仅复用已缓存 state.intraday，不发请求）
  function renderInlineIntraday() {
    const adv = state.posAdvice || [];
    adv.forEach(p => {
      const slot = document.querySelector(`#posList .pa-intraday[data-code="${p.code}"]`);
      if (!slot) return;
      const it = state.intraday && state.intraday[p.code];
      if (!it) {
        // 首屏骨架：已有实时价时先显示"分析中 + 现价/涨跌"，避免一直空白"加载中"
        const pa = (state.posAdvice || []).find(x => x.code === p.code) || {};
        const priceTxt = pa.price != null ? `现价 ${pa.price}` : "";
        const pctTxt = pa.change_pct != null
          ? ` <b style="color:${pa.change_pct >= 0 ? '#c92a2a' : '#2b8a3e'}">${pa.change_pct >= 0 ? '+' : ''}${pa.change_pct}%</b>` : "";
        slot.innerHTML = `<span style="color:var(--muted)">⏳ 分时分析中…</span>`
          + (priceTxt ? `<span style="margin-left:6px;color:var(--muted);font-size:11px">${priceTxt}${pctTxt}</span>` : "");
        return;
      }
      const m = it.metrics || {};
      const color = it.action_color || "#1971c2";
      const urgent = it.urgency === "立即" ? "animation:it-blink 1s infinite;" : "";
      const metTxt = [
        m.now_pct != null ? `<b style="color:${m.now_pct >= 0 ? '#c92a2a' : '#2b8a3e'}">${m.now_pct >= 0 ? '+' : ''}${m.now_pct}%</b>` : "",
        m.kdj_j != null ? `KDJ ${m.kdj_j} ${m.kdj_turn && m.kdj_turn !== '平稳' ? '·' + m.kdj_turn : ''}` : "",
        m.macd_status ? `MACD ${m.macd_status}` : "",
        m.vol_ratio != null ? `量比 ${m.vol_ratio}` : "",
      ].filter(Boolean).join("　");
      const tgt = it.target_price ? `${it.target_type || "操作"} ${it.target_price}` : "";
      slot.innerHTML = `<span style="display:inline-block;padding:2px 8px;border-radius:6px;background:${color}1a;color:${color};font-weight:600;${urgent}">⚡${it.action}</span>
        <span style="margin-left:6px;color:var(--muted)">${it.urgency}</span>
        ${metTxt ? `<span style="margin-left:8px;font-size:12px">${metTxt}</span>` : ""}
        ${tgt ? `<span style="margin-left:8px;color:#2b8a3e">${tgt}</span>` : ""}`;
    });
  }

  // 盘中实时建议：每只持仓 + 当前查看股票，按 1min/5min K 线的分时判断"该不该买/卖"
  // 一次批量请求并发算所有持仓（后端线程池），解决"逐只请求叠加 1m 现拉 → 一直加载"
  let _intradaySeq = 0;
  let _intradayBusy = false;  // 在途锁：上一轮未完成不发起新一轮，避免请求风暴
  let intradayPeriod = "1m";  // 分时周期：1m / 5m，前端可切换
  async function pollIntraday() {
    if (_intradayBusy) return;
    const codes = new Set();
    (state.posAdvice || []).forEach(p => codes.add(p.code));
    if (state.current && state.current.code) codes.add(state.current.code);
    if (!codes.size) return;
    _intradayBusy = true;
    try {
      const url = "/api/intraday_advice_batch?period=" + intradayPeriod +
                  "&codes=" + encodeURIComponent(Array.from(codes).join(","));
      const data = await api("GET", url);
      // 15:00 后停止更新：后端返回 closed，前端显示"已收盘"并停更
      if (data && data.closed) {
        const ul = document.getElementById("intradayList");
        if (ul) ul.innerHTML = `<li class="sub" style="padding:10px 0;color:var(--muted)">🌙 ${data.message || "已收盘，分时建议已停止更新"}</li>`;
        return;
      }
      if (!data || !data.results) return;
      const seq = ++_intradaySeq;
      if (seq !== _intradaySeq) return;  // 被更新的轮询抢占
      state.intraday = data.results;
      renderIntradayList();
      renderInlineIntraday();
    } catch (e) { /* 网络抖动忽略，下次轮询重试 */ }
    finally { _intradayBusy = false; }
  }
  function renderIntradayList() {
    const ul = $("#intradayList");
    if (!ul) return;
    const codes = new Set();
    (state.posAdvice || []).forEach(p => codes.add(p.code));
    if (state.current && state.current.code) codes.add(state.current.code);
    if (!codes.size) {
      ul.innerHTML = '<li class="sub" style="padding:8px 0;color:var(--muted);font-size:12px">无持仓或未选股时，分时建议自动停止。</li>';
      return;
    }
    const arr = Array.from(codes).map(code => {
      const pa = (state.posAdvice || []).find(p => p.code === code);
      const it = state.intraday && state.intraday[code];
      const name = (pa && pa.name) || (state.current && state.current.code === code ? state.current.name : "") || code;
      return { code, name, pa, it };
    });
    ul.innerHTML = arr.map(row => _intradayRowHtml(row)).join("");
  }
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
        const sugg = (op.suggestions || []).map(s => {
          const ac = s.action || "持有";
          const qty = s.qty ? ` ×${s.qty}股` : (ac === "买入" ? " 资金不足1手" : "");
          return `<div class="ds-row"><span class="ds-name">${s.name}<span style="color:#999;font-size:10px"> ${s.code}</span></span>
            <span class="ds-act" style="color:${_dsColor(ac)}">${ac}</span>
            <span class="ds-price">${s.price != null ? ("@" + s.price) : ""}${qty}</span>
            <span class="ds-reason">${s.reason || ""}</span></div>`;
        }).join("");
        openEl.innerHTML = `<div style="margin:4px 0 2px"><b style="color:${trColor};font-size:14px">${tr}</b> <span class="sub">置信度 ${op.confidence}%</span></div>
          <div class="sub" style="font-size:11px;color:#666;margin-bottom:4px">${op.market_note || ""}</div>
          ${sugg || '<span class="sub" style="color:var(--muted)">无明确建议</span>'}`;
      }
    }
    renderDailySnap(d);
    const revEl = document.getElementById("dailyReview");
    if (revEl) {
      const rv = d.review;
      if (!rv) {
        revEl.innerHTML = '<span class="sub" style="color:var(--muted)">收盘后（≥15:00）自动复盘：核对建议价是否触达、按建议做T盈亏与胜率。</span>';
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
      const d = await api("GET", "/api/review");
      if (!d || !d.rows || !d.rows.length) {
        el.innerHTML = `<div style="font-size:12px;color:var(--muted);padding:6px">今日暂无复盘记录。开盘后本工作台会自动记录每只持仓的「开盘建议 / 当日最高 / 收盘」，用来复盘你的判断准确率与按建议做T的盈亏。</div>`;
        return;
      }
      const rows = d.rows.map(r => {
        const ca = r.correct == null ? "—" : (r.correct ? "✅对" : "❌错");
        const caColor = r.correct == null ? "#868e96" : (r.correct ? "#2b8a3e" : "#c92a2a");
        const pnl = r.pnl != null ? `<b style="color:${r.pnl >= 0 ? '#2b8a3e' : '#c92a2a'}">${r.pnl >= 0 ? '+' : ''}${r.pnl.toFixed(0)}</b>` : "—";
        const oa = r.open_action || "—";
        const oaColor = ACT_COLOR[oa] || "#868e96";
        return `<div class="rev-row">
          <span class="rev-name">${r.name || r.code}<br><span style="color:#999;font-size:10px">${r.code}</span></span>
          <span class="rev-act" style="color:${oaColor}">${oa}</span>
          <span>建议价<b>${r.open_op_price != null ? fmt(r.open_op_price) : '—'}</b></span>
          <span>最高<b>${r.high != null ? fmt(r.high) : '—'}</b></span>
          <span>收盘<b>${r.close_price != null ? fmt(r.close_price) : '—'}</b></span>
          <span style="color:${caColor}">${ca}</span>
          <span>做T盈亏${pnl}</span>
        </div>`;
      }).join("");
      el.innerHTML = `<div style="font-size:11px;color:#666;margin-bottom:4px">${d.date} · 共 ${d.count} 只（按判断对错/盈亏排序；做T盈亏 = 按开盘建议价模拟操作至收盘的估算）</div>` + rows;
    } catch (e) { /* ignore */ }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
