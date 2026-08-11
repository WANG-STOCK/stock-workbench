/* 股票工作台前端控制器 */
(function () {
  const $ = (s) => document.querySelector(s);
  let API_BASE = localStorage.getItem("wb_api_base") || "";
  const api = async (method, url, body) => {
    const u = API_BASE ? (API_BASE.replace(/\/$/, "") + url) : url;
    const opt = { method, headers: { "Content-Type": "application/json" } };
    if (body) opt.body = JSON.stringify(body);
    const r = await fetch(u, opt);
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
    alerts: [],
    positions: [],   // [{code, name, shares, cost}]
    lastKline: null,
    triggeredSeen: new Set(),
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
    chart = new StockChart($("#chart"), $("#tooltip"));
    const cfg = await api("GET", "/api/config");
    $("#tdxStatus").textContent = cfg.tdx_available
      ? "数据源：通达信本地 + 在线" : "数据源：在线行情（未配置通达信）";
    $("#marketBadge").textContent = cfg.market || "A股";

    bindEvents();
    await loadWatchlist();
    await loadPositions();
    await computePositionSignals();
    setupWeights(cfg);
    $("#availCapital").value = (cfg.available_capital != null ? cfg.available_capital : 100000);
    $("#apiBase").value = API_BASE;
    $("#tdxPath").value = cfg.tdx_path || "";
    $("#tdxPathTip").textContent = cfg.tdx_available
      ? "已启用本地数据：" + cfg.tdx_path
      : "填好后，选股下拉选「通达信全市场」即可扫描全部 A 股日线（需先在通达信下载日线数据）。";
    startClock();
    startMonitor();
    startAlertCheck();
    startLiveView();
    state.timers.push(setInterval(computePositionSignals, 15000));
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

    // 指标开关
    ["tgBoll", "tgMacd", "tgKdj", "tgRsi"].forEach(id =>
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

    $("#addAlertBtn").addEventListener("click", addAlert);

    // 持仓台账
    $("#addPosBtn").addEventListener("click", addPosition);
    $("#saveWeights").addEventListener("click", saveWeights);
    $("#resetWeights").addEventListener("click", resetWeights);
    $("#saveApiBase").addEventListener("click", async () => {
      API_BASE = $("#apiBase").value.trim();
      localStorage.setItem("wb_api_base", API_BASE);
      try {
        await api("POST", "/api/config", { cloud_url: API_BASE });
        toast(API_BASE ? "已设云端后端：" + API_BASE : "已切回本机");
      } catch (e) {
        toast("云端地址已在本页生效，但后端未保存（推送链接仍指向本机）");
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

  function toggleOpts() {
    return {
      showBoll: $("#tgBoll").checked, showMacd: $("#tgMacd").checked,
      showKdj: $("#tgKdj").checked, showRsi: $("#tgRsi").checked,
    };
  }

  // ---------- 自选 ----------
  async function loadWatchlist() {
    state.watchlist = await api("GET", "/api/watchlist");
    if (!state.watchlist.length) {
      // 默认放几只龙头示范
      state.watchlist = ["sh600519", "sz000858", "sh601318", "sz300750"];
      await api("POST", "/api/watchlist", { codes: state.watchlist });
    }
    renderWatchlist();
    await pollQuotes();
    await computeSignals();
  }

  async function saveWatchlist() {
    await api("POST", "/api/watchlist", { codes: state.watchlist });
  }

  function renderWatchlist() {
    const ul = $("#watchlist");
    ul.innerHTML = state.watchlist.map(code => {
      const m = state.watchMeta[code] || {};
      const cur = state.current.code === code ? "active" : "";
      const act = m.action || "";
      const dot = act ? `<span class="sig-dot" style="background:${ACT_COLOR[act] || '#ccc'}"></span>` : `<span class="sig-dot" style="background:#ddd"></span>`;
      const px = m.price != null ? `<div class="wi-price"><div class="px ${chgClass(m.change)}">${fmt(m.price)}</div><div class="chg ${chgClass(m.change)}">${m.change_pct != null ? (m.change_pct >= 0 ? "+" : "") + fmt(m.change_pct) + "%" : ""}</div></div>` : `<div class="wi-price"></div>`;
      return `<li class="watch-item ${cur}" data-code="${code}">${dot}${px}
        <div class="wi-name"><div class="nm">${m.name || code}</div><div class="cd">${code}</div></div>
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
        state.watchlist = state.watchlist.filter(c => c !== el.dataset.code);
        delete state.watchMeta[el.dataset.code];
        await saveWatchlist(); renderWatchlist();
      }));
  }

  async function addCurrentToWatch() {
    if (!state.current.code) { toast("请先选择一只股票"); return; }
    if (state.watchlist.includes(state.current.code)) { toast("已在自选"); return; }
    state.watchlist.push(state.current.code);
    await saveWatchlist(); renderWatchlist(); await computeSignals();
  }

  async function pollQuotes() {
    if (!state.watchlist.length) return;
    const codes = state.watchlist;
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
    for (const code of state.watchlist) {
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
    renderAdvice(a.position, a.price);
  }

  function renderAdvice(pos, price) {
    const el = $("#adviceBody");
    if (!pos) { el.innerHTML = ""; return; }
    const cls = pos.action.includes("买入") ? "adv-buy" : pos.action.includes("卖出") ? "adv-sell" : "adv-hold";
    const pctTxt = (pos.target_pct * 100).toFixed(1) + "%";
    const deltaTxt = pos.delta_shares > 0 ? `买 ${pos.delta_shares} 股`
      : pos.delta_shares < 0 ? `卖 ${-pos.delta_shares} 股` : "不动";
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
      </div>`;
  }

  // ---------- 选股 ----------
  function renderScanRows(results, limit) {
    const rows = (results || []).slice(0, limit || 200).map(r => {
      const c = ACT_COLOR[r.action] || "#868e96";
      return `<div class="scan-row" data-code="${r.code}" data-name="${r.name}">
        <span class="tag" style="background:${c}">${r.action}</span>
        <span class="sc-name">${r.name || r.code}<br><span style="color:var(--muted);font-size:11px">${r.code}</span></span>
        <span class="sc-score ${chgClass(r.score)}">${r.score > 0 ? "+" : ""}${r.score}</span></div>`;
    }).join("");
    return rows;
  }
  function bindScanRows(el) {
    el.querySelectorAll(".scan-row").forEach(row =>
      row.addEventListener("click", () => openStock(row.dataset.code, row.dataset.name)));
  }

  // 候选股（十五五成长池）富表渲染
  function renderCandidateRows(results) {
    return (results || []).map(r => {
      const c = ACT_COLOR[r.action] || "#868e96";
      const gradeColor = { A: "#c92a2a", B: "#1971c2", C: "#868e96" }[r.fund_grade] || "#868e96";
      return `<div class="cand-row" data-code="${r.code}" data-name="${r.name}" style="padding:8px 4px;border-bottom:1px solid #eee;cursor:pointer">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span class="tag" style="background:${c}">${r.action}</span>
          <span style="font-weight:600">${r.name}</span><span style="color:#888;font-size:11px">${r.code}</span>
          <span style="color:#666;font-size:12px">· ${r.track}</span>
          <span style="color:#666;font-size:12px">· 赛道 ${r.sector_trend != null ? (r.sector_trend >= 0 ? "↑" : "↓") + fmt(r.sector_trend) + "%" : "—"}${r.sector_fund != null ? "　主力" + (r.sector_fund >= 0 ? "+" : "") + r.sector_fund.toFixed(1) + "亿" : ""}</span>
          <span style="margin-left:auto;font-size:12px">综合 <b style="font-size:14px">${r.combined}</b> <span style="color:#999">（技${r.tech_score}/基${r.fund_score}）</span></span>
        </div>
        <div style="display:flex;align-items:center;gap:14px;margin-top:5px;font-size:12px;flex-wrap:wrap">
          <span>现价 <b>${fmt(r.price)}</b></span>
          <span style="color:#c92a2a">买价 <b>${fmt(r.buy_price)}</b></span>
          <span style="color:#2b8a3e">卖价 <b>${fmt(r.sell_price)}</b></span>
          <span>买量 <b>${r.buy_qty}股</b></span>
          <span style="color:${gradeColor}">基本面 ${r.fund_grade}</span>
        </div>
        ${r.note ? `<div style="margin-top:4px;font-size:12px;color:#555">💡 ${r.note}</div>` : ""}
        ${r.reasons && r.reasons.length ? `<div style="margin-top:2px;font-size:11px;color:#999">${r.reasons.join("；")}</div>` : ""}
      </div>`;
    }).join("");
  }
  function bindCandidateRows(el) {
    el.querySelectorAll(".cand-row").forEach(row =>
      row.addEventListener("click", () => openStock(row.dataset.code, row.dataset.name)));
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

  // ---------- 预警 ----------
  async function loadAlerts() {
    state.alerts = await api("GET", "/api/alerts");
    renderAlerts();
  }
  function renderAlerts() {
    const ul = $("#alertList");
    ul.innerHTML = state.alerts.map(a =>
      `<li><span>${a.name || a.code}</span><span style="color:var(--muted)">${a.op === "above" ? "涨破" : "跌破"} ${a.value}</span><span class="ad" data-id="${a.id}">✕</span></li>`
    ).join("");
    ul.querySelectorAll(".ad").forEach(el =>
      el.addEventListener("click", async () => {
        await api("DELETE", "/api/alerts?id=" + el.dataset.id);
        await loadAlerts();
      }));
  }
  async function addAlert() {
    if (!state.current.code) { toast("请先选择股票"); return; }
    const value = parseFloat($("#alertValue").value);
    if (!value) { toast("请输入预警价格"); return; }
    await api("POST", "/api/alerts", {
      code: state.current.code, name: state.current.name, type: "price",
      op: $("#alertOp").value, value,
    });
    $("#alertValue").value = "";
    await loadAlerts();
    toast("预警已添加");
  }
  async function checkAlerts() {
    const trig = await api("GET", "/api/alerts/check");
    for (const t of trig) {
      const key = t.id + "_" + t.now;
      if (state.triggeredSeen.has(key)) continue;
      state.triggeredSeen.add(key);
      toast(`⏰ 预警触发：${t.name || t.code} ${t.op === "above" ? "涨破" : "跌破"} ${t.value}（现价 ${t.now}）`, 8);
    }
  }

  // ---------- 持仓台账 ----------
  async function loadPositions() {
    try { state.positions = await api("GET", "/api/positions"); } catch (e) { state.positions = []; }
    const codes = state.positions.map(p => p.code);
    if (codes.length) {
      const rt = await api("GET", "/api/quotes?codes=" + codes.join(",")).catch(() => ({}));
      for (const c of codes) if (rt[c]) {
        state.watchMeta[c] = { ...(state.watchMeta[c] || {}), name: rt[c].name, price: rt[c].price, change: rt[c].change, change_pct: rt[c].change_pct };
      }
    }
    renderPositions();
  }
  function tPlanHtml(p, m) {
    const tp = m.t_plan;
    if (!tp) return "";
    const tColor = { "做T买": "#c92a2a", "做T卖": "#2b8a3e", "做T买（逢低）": "#c92a2a", "持有不动": "#868e96" }[tp.t_action] || "#868e96";
    const qty = (tp.t_qty && tp.t_qty > 0) ? `做T量 ${tp.t_qty}股` : "暂不动";
    return `<div style="margin-top:5px;padding:5px 6px;background:#fff8e1;border-left:3px solid ${tColor};border-radius:4px;font-size:12px">
      <span style="font-weight:700;color:${tColor}">🔁 做T：${tp.t_action}</span>
      <span style="margin-left:6px;color:#c92a2a">低吸价 ${fmt(tp.t_buy_price)}</span>
      <span style="margin-left:6px;color:#2b8a3e">高抛价 ${fmt(tp.t_sell_price)}</span>
      <span style="margin-left:6px;font-weight:600">${qty}</span>
      ${tp.t_note ? `<div style="color:#666;margin-top:2px">${tp.t_note}</div>` : ""}
    </div>`;
  }

  function renderPositions() {
    const ul = $("#posList");
    if (!state.positions.length) { ul.innerHTML = `<li class="pos-empty">暂无持仓记录</li>`; return; }
    ul.innerHTML = state.positions.map(p => {
      const m = state.watchMeta[p.code] || {};
      const act = m.action || "";
      const actColor = (ACT_COLOR[act]) || "#868e96";
      let pl = "";
      if (m.price != null && p.cost > 0 && p.shares > 0) {
        const diff = (m.price - p.cost) * p.shares;
        const pct = (m.price / p.cost - 1) * 100;
        pl = `<span class="pl ${diff >= 0 ? "up" : "down"}">${diff >= 0 ? "+" : ""}${diff.toLocaleString("zh-CN", { maximumFractionDigits: 0 })} (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%)</span>`;
      }
      const priceTxt = m.price != null
        ? `<span class="px ${chgClass(m.change)}">${fmt(m.price)}</span> <span class="chg ${chgClass(m.change)}">${m.change_pct != null ? (m.change_pct >= 0 ? "+" : "") + fmt(m.change_pct) + "%" : ""}</span>`
        : `<span class="px">--</span>`;
      const buyTxt = m.buy_price != null ? fmt(m.buy_price) : "--";
      const sellTxt = m.sell_price != null ? fmt(m.sell_price) : "--";
      const actBadge = act
        ? `<span class="pos-act" style="background:${actColor};color:#fff">${act}</span>`
        : `<span class="pos-act" style="background:#adb5bd;color:#fff">信号计算中</span>`;
      return `<li class="pos-item" data-code="${p.code}" style="padding:8px 4px;border-bottom:1px solid #eee;cursor:pointer">
        <div style="display:flex;align-items:center;gap:6px">
          <span class="pos-name" style="font-weight:600">${p.name || p.code}</span>
          ${actBadge}
          <span class="wi-del" data-code="${p.code}" style="margin-left:auto">✕</span>
        </div>
        <div style="display:flex;align-items:center;gap:10px;margin-top:4px;font-size:13px">
          <span class="pos-code" style="color:#888;font-size:11px">${p.code} · ${p.shares}股</span>
          ${priceTxt}
        </div>
        <div style="display:flex;gap:14px;margin-top:4px;font-size:12px">
          <span style="color:#c92a2a">买价 <b>${buyTxt}</b></span>
          <span style="color:#2b8a3e">卖价 <b>${sellTxt}</b></span>
        </div>
        ${tPlanHtml(p, m)}
        ${pl ? `<div style="margin-top:2px;font-size:12px">${pl}</div>` : ""}
      </li>`;
    }).join("");
    ul.querySelectorAll(".wi-del").forEach(el => el.addEventListener("click", async (e) => {
      e.stopPropagation();
      await api("DELETE", "/api/positions?code=" + el.dataset.code);
      await loadPositions();
    }));
    ul.querySelectorAll(".pos-item").forEach(el => el.addEventListener("click", () => {
      const code = el.dataset.code;
      const m = state.watchMeta[code] || {};
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
    toast("已记录持仓：" + name);
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
  // 持仓股每 15 秒重算信号 + 建议买卖价（纯前端轮询，不推送）
  async function computePositionSignals() {
    if (!state.positions.length) return;
    for (const p of state.positions) {
      const code = p.code;
      try {
        const a = await api("GET", "/api/signal?code=" + code + "&period=daily&limit=120");
        if (a.ok) {
          const m = state.watchMeta[code] || {};
          m.action = a.action;
          m.score = a.score;
          m.buy_price = a.position ? a.position.buy_price : null;
          m.sell_price = a.position ? a.position.sell_price : null;
          m.t_plan = a.t_plan || null;
          state.watchMeta[code] = m;
        }
      } catch (e) { /* 网络抖动忽略 */ }
    }
    renderPositions();
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

  document.addEventListener("DOMContentLoaded", init);
})();
