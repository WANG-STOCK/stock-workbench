/* 轻量 Canvas 股票图表：K线 + 均线 + 成交量 + MACD/KDJ/RSI + BOLL 叠加。无外部依赖。 */

const C = {
  up: "#e03131", down: "#2f9e44", ink: "#1f2933", muted: "#7b8794",
  grid: "#eef1f4", axis: "#adb5bd",
  ma5: "#f08c00", ma10: "#1971c2", ma20: "#c2255c", ma60: "#6741d9",
  boll: "#0c8599", bollMid: "#868e96",
  dif: "#1971c2", dea: "#f08c00",
  k: "#1971c2", d: "#f08c00", j: "#9c36b5",
  rsi: "#e8590c",
};

class StockChart {
  constructor(canvas, tooltip) {
    this.canvas = canvas;
    this.tooltip = tooltip;
    this.ctx = canvas.getContext("2d");
    this.bars = [];
    this.ind = null;
    this.opts = { showBoll: true, showMacd: true, showKdj: true, showRsi: false };
    this.dpr = window.devicePixelRatio || 1;
    this.hover = -1;
    this._bind();
    this._ro = new ResizeObserver(() => this.render());
    this._ro.observe(canvas.parentElement);
  }

  setData(bars, ind, opts) {
    this.bars = bars || [];
    this.ind = ind || null;
    if (opts) this.opts = { ...this.opts, ...opts };
    this.render();
  }

  _bind() {
    this.canvas.addEventListener("mousemove", (e) => {
      const r = this.canvas.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      this._onMove(x, y);
    });
    this.canvas.addEventListener("mouseleave", () => {
      this.hover = -1; this.tooltip.style.display = "none"; this.render();
    });
  }

  _layout() {
    const box = this.canvas.parentElement;
    const W = box.clientWidth, H = box.clientHeight;
    this.canvas.width = W * this.dpr;
    this.canvas.height = H * this.dpr;
    this.canvas.style.width = W + "px";
    this.canvas.style.height = H + "px";
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    const padL = 8, padR = 58, axisB = 20, topPad = 6;
    const plotW = W - padL - padR;
    const plotH = H - axisB - topPad;
    const subs = [];
    if (this.opts.showMacd) subs.push("macd");
    if (this.opts.showKdj) subs.push("kdj");
    if (this.opts.showRsi) subs.push("rsi");
    let volH = 60, subH = 84;
    let needed = volH + subs.length * subH;
    let mainH = plotH - needed;
    if (mainH < 130) {
      mainH = 130;
      const rest = plotH - mainH;
      volH = Math.min(60, rest * 0.28);
      subH = (rest - volH) / Math.max(1, subs.length);
    }
    const y0 = topPad;
    const mainRect = { x: padL, y: y0, w: plotW, h: mainH };
    const volRect = { x: padL, y: y0 + mainH, w: plotW, h: volH };
    const subRects = {};
    let yy = y0 + mainH + volH;
    for (const s of subs) { subRects[s] = { x: padL, y: yy, w: plotW, h: subH }; yy += subH; }
    return { W, H, padL, padR, plotW, axisB, mainRect, volRect, subRects, subs };
  }

  render() {
    const ctx = this.ctx;
    const L = this._layout();
    ctx.clearRect(0, 0, L.W, L.H);
    if (!this.bars.length) {
      ctx.fillStyle = C.muted; ctx.font = "13px sans-serif";
      ctx.fillText("暂无数据", 20, 30); return;
    }
    const bars = this.bars, N = bars.length;
    const barW = L.plotW / N;
    const xOf = (i) => L.padL + barW * (i + 0.5);

    // 价格范围
    let lo = Infinity, hi = -Infinity;
    for (const b of bars) { lo = Math.min(lo, b.low); hi = Math.max(hi, b.high); }
    if (this.opts.showBoll && this.ind) {
      for (const v of this.ind.boll.upper) if (v != null) hi = Math.max(hi, v);
      for (const v of this.ind.boll.lower) if (v != null) lo = Math.min(lo, v);
    }
    const pad = (hi - lo) * 0.06 || 1; hi += pad; lo -= pad;
    const yPrice = (v) => L.mainRect.y + (hi - v) / (hi - lo) * L.mainRect.h;

    // 网格 + 价格刻度
    ctx.strokeStyle = C.grid; ctx.fillStyle = C.muted; ctx.font = "11px sans-serif";
    ctx.lineWidth = 1;
    const ticks = 4;
    for (let t = 0; t <= ticks; t++) {
      const v = hi - (hi - lo) * t / ticks;
      const y = yPrice(v);
      ctx.beginPath(); ctx.moveTo(L.padL, y); ctx.lineTo(L.padL + L.plotW, y); ctx.stroke();
      ctx.fillText(v.toFixed(2), L.padL + L.plotW + 4, y + 3);
    }

    // 蜡烛
    const cw = Math.max(1, barW * 0.66);
    for (let i = 0; i < N; i++) {
      const b = bars[i];
      const x = xOf(i);
      const up = b.close >= b.open;
      ctx.strokeStyle = ctx.fillStyle = up ? C.up : C.down;
      ctx.beginPath(); ctx.moveTo(x, yPrice(b.high)); ctx.lineTo(x, yPrice(b.low)); ctx.stroke();
      const yo = yPrice(b.open), yc = yPrice(b.close);
      const top = Math.min(yo, yc), h = Math.max(1, Math.abs(yc - yo));
      ctx.fillRect(x - cw / 2, top, cw, h);
    }

    // 均线
    const drawMA = (arr, color) => {
      ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.beginPath();
      let started = false;
      for (let i = 0; i < N; i++) {
        const v = arr[i];
        if (v == null) { started = false; continue; }
        const x = xOf(i), y = yPrice(v);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };
    if (this.ind) {
      drawMA(this.ind.ma5, C.ma5); drawMA(this.ind.ma10, C.ma10);
      drawMA(this.ind.ma20, C.ma20); drawMA(this.ind.ma60, C.ma60);
      if (this.opts.showBoll) {
        drawMA(this.ind.boll.upper, C.boll);
        drawMA(this.ind.boll.mid, C.bollMid);
        drawMA(this.ind.boll.lower, C.boll);
      }
    }

    // 成交量
    const volRect = L.volRect;
    let vmax = 0; for (const b of bars) vmax = Math.max(vmax, b.volume);
    if (this.ind && this.ind.vol_ma5) for (const v of this.ind.vol_ma5) if (v) vmax = Math.max(vmax, v);
    const yVol = (v) => volRect.y + (1 - v / vmax) * volRect.h;
    for (let i = 0; i < N; i++) {
      const b = bars[i], x = xOf(i);
      ctx.fillStyle = b.close >= b.open ? C.up : C.down;
      ctx.globalAlpha = 0.65;
      const y = yVol(b.volume);
      ctx.fillRect(x - cw / 2, y, cw, volRect.y + volRect.h - y);
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = C.muted; ctx.fillText("VOL", L.padL + 2, volRect.y + 12);
    // 量能MA
    if (this.ind && this.ind.vol_ma5) {
      ctx.strokeStyle = C.ma10; ctx.lineWidth = 1; ctx.beginPath(); let st = false;
      for (let i = 0; i < N; i++) { const v = this.ind.vol_ma5[i]; if (v == null) { st = false; continue; } const x = xOf(i), y = yVol(v); if (!st) { ctx.moveTo(x, y); st = true; } else ctx.lineTo(x, y); }
      ctx.stroke();
    }

    // 子图
    for (const s of L.subs) this._drawSub(s, L.subRects[s], xOf, barW);

    // 日期轴
    ctx.fillStyle = C.muted; ctx.textAlign = "center";
    const step = Math.max(1, Math.floor(N / 6));
    for (let i = 0; i < N; i += step) {
      const d = bars[i].date; const label = d.length > 10 ? d.slice(5, 16) : d.slice(5);
      ctx.fillText(label, xOf(i), L.H - 6);
    }
    ctx.textAlign = "left";

    // 十字光标
    if (this.hover >= 0 && this.hover < N) {
      const x = xOf(this.hover);
      ctx.strokeStyle = "#868e96"; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(x, L.mainRect.y); ctx.lineTo(x, L.H - L.axisB); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  _drawSub(name, R, xOf, barW) {
    const ctx = this.ctx, bars = this.bars, N = bars.length, ind = this.ind;
    if (!ind) return;
    ctx.strokeStyle = C.grid; ctx.fillStyle = C.muted; ctx.font = "10px sans-serif";
    ctx.beginPath(); ctx.moveTo(R.x, R.y); ctx.lineTo(R.x + R.w, R.y); ctx.stroke();
    ctx.fillText(name.toUpperCase(), R.x + 2, R.y + 11);

    const line = (arr, color) => {
      ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.beginPath(); let st = false;
      for (let i = 0; i < N; i++) { const v = arr[i]; if (v == null) { st = false; continue; } const x = xOf(i), y = yMap(v); if (!st) { ctx.moveTo(x, y); st = true; } else ctx.lineTo(x, y); }
      ctx.stroke();
    };
    let yMap, lo, hi;
    if (name === "macd") {
      const a = ind.macd; let mx = -Infinity, mn = Infinity;
      for (const arr of [a.dif, a.dea, a.hist]) for (const v of arr) if (v != null) { mx = Math.max(mx, v); mn = Math.min(mn, v); }
      const p = (mx - mn) * 0.1 || 1; mx += p; mn -= p; lo = mn; hi = mx;
      yMap = (v) => R.y + (hi - v) / (hi - lo) * R.h;
      const zy = yMap(0); ctx.strokeStyle = C.axis; ctx.beginPath(); ctx.moveTo(R.x, zy); ctx.lineTo(R.x + R.w, zy); ctx.stroke();
      // 柱
      const cw = Math.max(1, barW * 0.6);
      for (let i = 0; i < N; i++) { const v = a.hist[i]; if (v == null) continue; const x = xOf(i); ctx.fillStyle = v >= 0 ? C.up : C.down; const y = yMap(v); ctx.fillRect(x - cw / 2, Math.min(y, zy), cw, Math.abs(y - zy)); }
      line(a.dif, C.dif); line(a.dea, C.dea);
    } else if (name === "kdj") {
      lo = 0; hi = 100; yMap = (v) => R.y + (hi - v) / (hi - lo) * R.h;
      ctx.strokeStyle = C.axis; ctx.setLineDash([3, 3]);
      for (const lv of [20, 80]) { const y = yMap(lv); ctx.beginPath(); ctx.moveTo(R.x, y); ctx.lineTo(R.x + R.w, y); ctx.stroke(); }
      ctx.setLineDash([]);
      line(ind.kdj.k, C.k); line(ind.kdj.d, C.d); line(ind.kdj.j, C.j);
    } else if (name === "rsi") {
      lo = 0; hi = 100; yMap = (v) => R.y + (hi - v) / (hi - lo) * R.h;
      ctx.strokeStyle = C.axis; ctx.setLineDash([3, 3]);
      for (const lv of [30, 70]) { const y = yMap(lv); ctx.beginPath(); ctx.moveTo(R.x, y); ctx.lineTo(R.x + R.w, y); ctx.stroke(); }
      ctx.setLineDash([]);
      line(ind.rsi.rsi6, C.rsi); line(ind.rsi.rsi12, C.ma10); line(ind.rsi.rsi24, C.ma60);
    }
  }

  _onMove(x, y) {
    const L = this._layout();
    if (x < L.padL || x > L.padL + L.plotW) { this.hover = -1; this.tooltip.style.display = "none"; this.render(); return; }
    const N = this.bars.length;
    const barW = L.plotW / N;
    const i = Math.max(0, Math.min(N - 1, Math.floor((x - L.padL) / barW)));
    this.hover = i;
    this.render();
    const b = this.bars[i];
    const up = b.close >= b.open;
    const ind = this.ind;
    let html = `<b>${b.date}</b>　${up ? '<span style="color:#ff8787">涨</span>' : '<span style="color:#69db7c">跌</span>'}<br>`;
    html += `开 ${b.open.toFixed(2)}　高 ${b.high.toFixed(2)}<br>低 ${b.low.toFixed(2)}　收 ${b.close.toFixed(2)}<br>量 ${(b.volume / 10000).toFixed(2)}万手`;
    if (ind) {
      const m = ind.macd, k = ind.kdj, r = ind.rsi;
      if (m.dif[i] != null) html += `<br>MACD ${m.dif[i].toFixed(2)}/${m.dea[i].toFixed(2)}`;
      if (k.k[i] != null) html += `<br>KDJ ${k.k[i].toFixed(1)}/${k.d[i].toFixed(1)}/${k.j[i].toFixed(1)}`;
      if (r.rsi6[i] != null) html += `<br>RSI ${r.rsi6[i].toFixed(0)}/${r.rsi12[i].toFixed(0)}/${r.rsi24[i].toFixed(0)}`;
    }
    const tip = this.tooltip;
    tip.innerHTML = html;
    tip.style.display = "block";
    const box = this.canvas.parentElement.getBoundingClientRect();
    let tx = x + 14, ty = y + 14;
    if (tx + tip.offsetWidth > box.width) tx = x - tip.offsetWidth - 14;
    if (ty + tip.offsetHeight > box.height) ty = y - tip.offsetHeight - 14;
    tip.style.left = tx + "px"; tip.style.top = ty + "px";
  }
}
window.StockChart = StockChart;
