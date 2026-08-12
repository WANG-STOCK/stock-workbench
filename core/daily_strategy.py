# -*- coding: utf-8 -*-
"""每日策略引擎：开盘判断 + 四时点快照 + 收盘复盘（量化信号记账，不下单）。

设计要点（与王总确认）：
- 自动定时抓取：9:30 开盘判断、9:30/10:30/13:00/14:00 四时点快照、15:00 后复盘。
- 数量按资金比例：买入 = 可用资金 * buy_pct（默认 15%）取整到百股；卖出 = 持仓 * sell_pct（默认 1/3）。
- 尾盘策略扫描范围为「十五五行业池」（data/industry_pool.json，约 391 只）。
- 所有建议只记录与复盘，不在任何券商自动下单；复盘核对"若照做当天盈亏"。
"""
import os
import json
import time
from datetime import datetime

import core.data_source as ds
import core.intraday as intraday_mod

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(HERE)
DATA_DIR = os.path.join(BASE, "data")
STATIC_DIR = os.path.join(BASE, "static")

DS_FILE = os.path.join(DATA_DIR, "daily_strategy.json")
POSITIONS = os.path.join(DATA_DIR, "positions.json")
STATIC_POSITIONS = os.path.join(STATIC_DIR, "positions.json")
POOL_FILE = os.path.join(DATA_DIR, "industry_pool.json")
CONFIG_FILE = os.path.join(DATA_DIR, "config.json")

SNAP_TIMES = ["09:30", "10:00", "10:30", "13:00", "14:00"]
SNAP_MIN = {"09:30": 570, "10:00": 600, "10:30": 630, "13:00": 780, "14:00": 840}


# ---------------- 基础 IO ----------------
def _now_str():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _today():
    return datetime.now().strftime("%Y-%m-%d")


def _load_json(path, default):
    try:
        if os.path.isfile(path):
            with open(path, encoding="utf-8") as f:
                return json.load(f)
    except Exception:
        pass
    return default


def _save_json(path, obj):
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def _load():
    return _load_json(DS_FILE, {})


def _save(d):
    _save_json(DS_FILE, d)


def _load_positions():
    p = _load_json(POSITIONS, None)
    if p is not None:
        return p
    return _load_json(STATIC_POSITIONS, [])


def _load_pool():
    return _load_json(POOL_FILE, [])


def _cfg():
    return _load_json(CONFIG_FILE, {})


def _sizing():
    c = _cfg()
    avail = float((c.get("available_capital") or c.get("position", {}).get("capital") or 100000))
    buy_pct = float(c.get("daily_strategy", {}).get("buy_pct", 0.15))
    sell_pct = float(c.get("daily_strategy", {}).get("sell_pct", 1.0 / 3.0))
    return avail, buy_pct, sell_pct


def size_buy(price):
    if not price or price <= 0:
        return 0
    avail, buy_pct, _ = _sizing()
    budget = avail * buy_pct
    qty = int(budget / price) // 100 * 100
    return max(qty, 100) if qty >= 100 else 0


def size_sell(held):
    if not held or held < 100:
        return 0
    _, _, sell_pct = _sizing()
    raw = int(held * sell_pct)
    qty = (raw // 100) * 100
    if qty < 100:
        qty = 100  # 持仓≥100股时至少建议 1 手（止盈一部分）
    return min(qty, (held // 100) * 100)  # 不超过持仓


# ---------------- 技术打分（日线） ----------------
def _daily_k(code, limit=60):
    try:
        bars = ds.get_kline(code, "daily", limit)
        if bars:
            return bars
    except Exception:
        pass
    return []


def _tech_score_daily(bars, q):
    """返回 (score -4..+4, signals, overbought, oversold)。"""
    if not bars or len(bars) < 6:
        return 0, ["数据不足"], False, False
    closes = [b["close"] for b in bars if b.get("close")]
    if len(closes) < 6:
        return 0, ["数据不足"], False, False
    last = closes[-1]
    prev = closes[-2]
    ma5 = sum(closes[-5:]) / 5
    ma10 = sum(closes[-10:]) / 10
    ma20 = sum(closes[-20:]) / 20 if len(closes) >= 20 else ma10
    pct = (last - prev) / prev * 100 if prev else 0
    slope = (closes[-1] - closes[-3]) / closes[-3] * 100 if len(closes) >= 3 and closes[-3] else 0
    score = 0
    sig = []
    if last > ma5:
        score += 1
        sig.append("价在MA5上")
    else:
        score -= 1
        sig.append("价在MA5下")
    if ma5 > ma10:
        score += 1
        sig.append("MA5>MA10多头")
    else:
        score -= 1
        sig.append("MA5<MA10")
    if ma10 > ma20:
        score += 1
    else:
        score -= 1
    if pct > 1:
        score += 1
        sig.append(f"昨涨{pct:.1f}%")
    elif pct < -1:
        score -= 1
        sig.append(f"昨跌{pct:.1f}%")
    if slope > 2:
        score += 1
    elif slope < -2:
        score -= 1
    op = q.get("open")
    pc = q.get("prev_close") or prev
    if op and pc:
        gap = (op - pc) / pc * 100
        if gap > 0.5:
            score += 1
            sig.append(f"高开{gap:.1f}%")
        elif gap < -0.5:
            score -= 1
            sig.append(f"低开{gap:.1f}%")
    overbought = last > ma20 * 1.10 and pct > 4
    oversold = last < ma20 * 0.93
    if overbought:
        sig.append("短线超买")
    if oversold:
        sig.append("短线超卖")
    return score, sig, overbought, oversold


# ---------------- 盘中建议（复用 intraday 模块） ----------------
def _intraday_advice(code, q, period="5m"):
    price = (q or {}).get("price")
    prev_close = (q or {}).get("prev_close")
    try:
        bars = ds.get_kline(code, period, 60)
    except Exception:
        bars = []
    if not price and bars:
        price = bars[-1]["close"]
    if not prev_close and bars:
        prev_close = bars[-2]["close"] if len(bars) >= 2 else bars[-1]["close"]
    if not price or not prev_close:
        return {}
    return intraday_mod.intraday_advice(q or {}, bars or [], prev_close)


def _map_action(adv_action):
    a = adv_action or ""
    if "买" in a:
        return "买入"
    if "卖" in a or "止盈" in a or "减仓" in a:
        return "卖出"
    return "持有"


# ---------------- 开盘判断 ----------------
def open_judgment(date=None):
    date = date or _today()
    positions = _load_positions()
    pool = _load_pool()
    grade_a = [p for p in pool if str(p.get("grade", "")).upper() == "A"][:50]
    held_codes = {p.get("code") for p in positions}
    cand = [p for p in grade_a if p.get("code") not in held_codes]

    codes = [p.get("code") for p in positions] + [p.get("code") for p in cand]
    rt = {}
    try:
        rt = ds.fetch_realtime(codes) or {}
    except Exception:
        rt = {}

    bull = bear = 0
    sugg = []

    for p in positions:
        code = p.get("code")
        name = p.get("name", code)
        held = int(p.get("shares", 0) or 0)
        q = rt.get(code, {})
        bars = _daily_k(code)
        score, sig, ob, os_ = _tech_score_daily(bars, q)
        if score > 0:
            bull += 1
        elif score < 0:
            bear += 1
        if ob:
            action = "卖出"
            reason = "短线超买，建议止盈1/3：" + "、".join(sig[:2])
        elif score >= 2:
            action = "持有"
            reason = "多头排列：" + "、".join(sig[:2])
        elif score <= -2:
            action = "减仓"
            reason = "转弱：" + "、".join(sig[:2])
        else:
            action = "持有"
            reason = "震荡：" + "、".join(sig[:2])
        price = (q.get("price") or (bars[-1]["close"] if bars else None))
        price = round(price, 2) if price else None
        qty = size_sell(held) if action in ("卖出", "减仓") else 0
        forecast = _quick_forecast(bars, q, score, sig)
        sugg.append({
            "code": code, "name": name, "role": "holding",
            "action": action, "price": price, "qty": qty,
            "reason": reason, "track": p.get("track", ""), "grade": p.get("grade", ""),
            "forecast": forecast, "score": score,
        })

    for p in cand:
        code = p.get("code")
        name = p.get("name", code)
        q = rt.get(code, {})
        bars = _daily_k(code)
        score, sig, ob, os_ = _tech_score_daily(bars, q)
        if not (os_ or (score >= 1 and not ob)):
            continue
        action = "买入"
        price = (q.get("price") or (bars[-1]["close"] if bars else None))
        price = round(price, 2) if price else None
        qty = size_buy(price) if price else 0
        reason = ("超卖反弹" if os_ else "多头初现") + "、" + "、".join(sig[:2])
        forecast = _quick_forecast(bars, q, score, sig)
        sugg.append({
            "code": code, "name": name, "role": "candidate",
            "action": action, "price": price, "qty": qty,
            "reason": reason, "track": p.get("track", ""), "grade": p.get("grade", ""),
            "forecast": forecast, "score": score,
        })

    total = bull + bear
    if bull > bear * 1.15:
        trend = "up"
    elif bear > bull * 1.15:
        trend = "down"
    else:
        trend = "sideways"
    conf = round(100 * max(bull, bear) / (total + 1))

    # 按"购买优先级"对 suggestions 排序（买入最优先 → 持有 → 卖出/减仓；同类按 forecast.pct / score 排）
    #   action_rank: 买入=0(优先) > 持有=1 > 卖出/减仓=2
    #   但"减仓"对持仓是告警，也要显眼，所以卖出=2、减仓=2
    def _prio(s):
        a = s.get("action", "")
        if a == "买入":
            return (0, -(s.get("forecast") or {}).get("pct", 0))   # 预期涨幅高在前
        if a in ("卖出", "减仓"):
            return (2, -abs((s.get("forecast") or {}).get("pct", 0)))  # 跌幅大在前（警告大）
        # 持有
        return (1, -abs(s.get("score", 0)))
    sugg.sort(key=_prio)

    rec = {
        "generated_at": _now_str(),
        "trend": trend,
        "confidence": conf,
        "market_note": f"偏多 {bull} 只 / 偏空 {bear} 只（持仓+评级A候选），综合集合竞价与均线信号。建议按下方优先级排序，<b style='color:#2b8a3e'>买入</b>排最前（预期空间最大），<b style='color:#c92a2a'>卖出/减仓</b>排最后（风险高需处理）。",
        "suggestions": sugg,
    }
    d = _load()
    day = d.setdefault(date, {})
    day["date"] = date
    day["open"] = rec
    _save(d)
    return rec


def _quick_forecast(bars, q, score, sig):
    """轻量级今日预估（开盘判断/快照用，不需要 MACD/KDJ）。"""
    basis = []
    pct = 0.0
    prev_close = q.get("prev_close")
    op = q.get("open")
    price = q.get("price")
    closes = [b["close"] for b in bars] if bars else []
    if op and prev_close:
        gap = (op - prev_close) / prev_close * 100
        if gap >= 0.5:
            basis.append(f"高开 +{gap:.1f}%（集合竞价偏多）")
            pct += 0.5
        elif gap <= -0.5:
            basis.append(f"低开 {gap:.1f}%（集合竞价偏空）")
            pct -= 0.5
    if len(closes) >= 20 and price:
        ma5 = sum(closes[-5:]) / 5
        ma10 = sum(closes[-10:]) / 10
        ma20 = sum(closes[-20:]) / 20
        if price > ma5 > ma10 > ma20:
            basis.append("价>MA5>MA10>MA20 多头")
            pct += 1.2
        elif price < ma5 < ma10 < ma20:
            basis.append("价<MA5<MA10<MA20 空头")
            pct -= 1.2
        elif price > ma20:
            basis.append("价站上MA20 偏多")
            pct += 0.5
        elif price < ma20:
            basis.append("价跌破MA20 偏空")
            pct -= 0.5
    # 技术打分辅助
    if score >= 2:
        pct += 0.5
    elif score <= -2:
        pct -= 0.5
    if pct >= 0.8:
        trend = "偏多"
    elif pct <= -0.8:
        trend = "偏空"
    else:
        trend = "震荡"
    if not basis:
        basis.append("信号不足 震荡")
    return {"trend": trend, "pct": round(pct, 2), "basis": basis[:5]}


# ---------------- 四时点快照 ----------------
def generate_snapshot(time_label, date=None):
    date = date or _today()
    positions = _load_positions()
    pool = _load_pool()
    grade_a = [p for p in pool if str(p.get("grade", "")).upper() == "A"][:50]
    held_codes = {p.get("code") for p in positions}

    items = []
    for p in positions:
        items.append({"code": p.get("code"), "name": p.get("name", p.get("code")),
                      "role": "holding", "held": int(p.get("shares", 0) or 0),
                      "track": p.get("track", ""), "grade": p.get("grade", "")})
    for p in grade_a:
        if p.get("code") in held_codes:
            continue
        items.append({"code": p.get("code"), "name": p.get("name", p.get("code")),
                      "role": "candidate", "held": 0,
                      "track": p.get("track", ""), "grade": p.get("grade", "")})

    codes = [it["code"] for it in items]
    rt = {}
    try:
        rt = ds.fetch_realtime(codes) or {}
    except Exception:
        rt = {}

    rows = []
    for it in items:
        code = it["code"]
        q = rt.get(code, {})
        try:
            adv = _intraday_advice(code, q, period="5m")
        except Exception:
            adv = {}
        m = adv.get("metrics", {}) or {}
        adv_action = adv.get("action", "持有观察")
        action = _map_action(adv_action)
        price = adv.get("target_price") or q.get("price")
        price = round(price, 2) if price else None
        qty = size_buy(price) if action == "买入" else (size_sell(it["held"]) if action == "卖出" else 0)
        reasons = adv.get("reasons") or []
        reason = (reasons[0].get("text") if isinstance(reasons[0], dict) else reasons[0]) if reasons else adv_action
        rows.append({
            "code": code, "name": it["name"], "role": it["role"],
            "action": action, "price": price, "qty": qty,
            "reason": reason, "now_pct": m.get("now_pct"),
            "scenario": adv.get("scenario"),
        })

    rec = {"ts": _now_str(), "rows": rows}
    d = _load()
    day = d.setdefault(date, {})
    day["date"] = date
    day.setdefault("snapshots", {})[time_label] = rec
    _save(d)
    return rec


# ---------------- 收盘复盘 ----------------
def _day_hlc(code):
    try:
        q = ds.fetch_realtime([code]).get(code, {}) or {}
        if q.get("high") and q.get("low") and q.get("price"):
            return q.get("high"), q.get("low"), q.get("price")
    except Exception:
        pass
    try:
        bars = ds.get_kline(code, "daily", 5)
        if bars:
            b = bars[-1]
            return b.get("high"), b.get("low"), b.get("close")
    except Exception:
        pass
    return None, None, None


def generate_review(date=None):
    """收盘复盘：四时点建议价 vs 尾盘 + 最高最低，输出准确率 + 下次如何改进（calibration）。"""
    date = date or _today()
    d = _load()
    day = d.get(date, {})

    entries = []
    op = day.get("open")
    if op:
        for s in op.get("suggestions", []):
            entries.append(("开盘判断", s))
    for t, snap in (day.get("snapshots") or {}).items():
        for s in snap.get("rows", []):
            entries.append((t, s))

    codes = list({s.get("code") for _, s in entries})
    hlc = {}
    for c in codes:
        hlc[c] = _day_hlc(c)

    rows = []
    for src, s in entries:
        code = s.get("code")
        name = s.get("name", code)
        action = s.get("action")
        price = s.get("price")
        qty = s.get("qty") or 0
        hi, lo, cl = hlc.get(code, (None, None, None))
        hit = None
        pnl = None
        correct = None
        # 建议价相对最高/最低/收盘的偏差（用于诊断建议价是否合理）
        dev_hi = None
        dev_lo = None
        dev_close = None
        if price and cl is not None:
            dev_close = round((price - cl) / cl * 100, 2)
        if price and hi:
            dev_hi = round((price - hi) / hi * 100, 2)
        if price and lo:
            dev_lo = round((price - lo) / lo * 100, 2)
        if price and cl is not None:
            if action == "买入":
                hit = (lo is not None and lo <= price)
                pnl = round((cl - price) * qty, 2) if qty else None
                correct = cl > price
            elif action == "卖出":
                hit = (hi is not None and hi >= price)
                pnl = round((price - cl) * qty, 2) if qty else None
                correct = cl < price
        rows.append({
            "code": code, "name": name, "role": s.get("role"),
            "source": src, "action": action, "price": price, "qty": qty,
            "high": hi, "low": lo, "close": cl,
            "hit": hit, "pnl": pnl, "correct": correct,
            "dev_hi_pct": dev_hi, "dev_lo_pct": dev_lo, "dev_close_pct": dev_close,
        })

    decided = [r for r in rows if r["correct"] is not None]
    win = sum(1 for r in decided if r["correct"])
    total_pnl = round(sum((r["pnl"] or 0) for r in rows), 2)
    summary = {
        "evaluated": len(decided),
        "win_rate": round(win / max(len(decided), 1) * 100, 1),
        "win_count": win,
        "total_pnl": total_pnl,
    }
    # ===== 自适应校准：根据今天的不准确情况，下次如何改进 =====
    calibration = _calibrate(rows, decided)
    rec = {
        "closed_at": _now_str(),
        "summary": summary,
        "rows": rows,
        "calibration": calibration,
    }
    day["review"] = rec
    _save(d)
    return rec


def _calibrate(rows, decided):
    """根据今天的复盘输出下次如何改进（calibration）。

    规则：
    - 卖出建议但收盘 > 建议价×1.03 → 卖价过高 → 下次约束在 +1.5% 内
    - 买入建议但收盘 < 建议价×0.97 → 买价过低/追跌 → 下次约束在 -1.5% 内
    - 命中率 < 40% → 该动作方向判断差 → 建议降低操作频率（更多「持有」）
    - 命中率 ≥ 70% → 当前规则有效 → 沿用
    """
    tips = []
    detail = {"sell_too_high": [], "buy_too_low": [], "miss_actions": [], "good_actions": []}
    if not decided:
        return {"tips": ["今日没有可判断的买卖建议，无法校准"], "detail": detail}
    # 卖出价偏离
    sell_miss = [r for r in decided if r["action"] == "卖出" and r["dev_close_pct"] is not None and r["dev_close_pct"] > 3]
    for r in sell_miss[:5]:
        detail["sell_too_high"].append({"code": r["code"], "name": r["name"], "source": r["source"],
                                       "price": r["price"], "close": r["close"], "dev_pct": r["dev_close_pct"]})
    if sell_miss:
        tips.append(f"⚠️ {len(sell_miss)} 次卖价高于收盘+3%（价格当天到不了），下次自动约束到 +1.5% 内")
    # 买价偏离
    buy_miss = [r for r in decided if r["action"] == "买入" and r["dev_close_pct"] is not None and r["dev_close_pct"] < -3]
    for r in buy_miss[:5]:
        detail["buy_too_low"].append({"code": r["code"], "name": r["name"], "source": r["source"],
                                     "price": r["price"], "close": r["close"], "dev_pct": r["dev_close_pct"]})
    if buy_miss:
        tips.append(f"⚠️ {len(buy_miss)} 次买价低于收盘-3%（追跌），下次约束到 -1.5% 内")
    # 按方向胜率
    by_action = {}
    for r in decided:
        by_action.setdefault(r["action"], []).append(r)
    for act, lst in by_action.items():
        wr = sum(1 for r in lst if r["correct"]) / max(len(lst), 1) * 100
        if wr < 40 and len(lst) >= 2:
            tips.append(f"📉 {act}方向胜率仅 {wr:.0f}%（{len(lst)}次），下次该方向降低操作频率")
            detail["miss_actions"].append({"action": act, "win_rate": round(wr, 1), "count": len(lst)})
        elif wr >= 70 and len(lst) >= 2:
            tips.append(f"✅ {act}方向胜率 {wr:.0f}%（{len(lst)}次），规则有效，继续沿用")
            detail["good_actions"].append({"action": act, "win_rate": round(wr, 1), "count": len(lst)})
    # 按时点胜率
    by_src = {}
    for r in decided:
        by_src.setdefault(r["source"], []).append(r)
    for src, lst in by_src.items():
        wr = sum(1 for r in lst if r["correct"]) / max(len(lst), 1) * 100
        if wr < 40 and len(lst) >= 3:
            tips.append(f"⏰ {src}时点胜率 {wr:.0f}%（{len(lst)}次），该时点判断质量差，下次该时点更保守")
    if not tips:
        tips.append("✅ 今日建议整体合理，继续沿用现有规则")
    # 持久化校准建议（供 open_judgment/snapshot 读取并应用）
    try:
        cal = _load_json(os.path.join(DATA_DIR, "strategy_calibration.json"), {"history": []})
        cal.setdefault("history", []).append({
            "date": _today(), "tips": tips,
            "sell_too_high_count": len(sell_miss),
            "buy_too_low_count": len(buy_miss),
            "miss_actions": detail["miss_actions"],
            "good_actions": detail["good_actions"],
        })
        cal["history"] = cal["history"][-30:]   # 保留最近 30 天
        cal["latest_tips"] = tips
        _save_json(os.path.join(DATA_DIR, "strategy_calibration.json"), cal)
    except Exception:
        pass
    return {"tips": tips, "detail": detail}


# ---------------- 编排（自动维护） ----------------
def _now_min():
    now = datetime.now()
    return now.hour * 60 + now.minute


def run_daily(mode="auto", t=None, date=None):
    """自动维护当日记录：缺失的开盘判断/已过时点快照/收盘复盘，各只生成一次。"""
    date = date or _today()
    d = _load()
    day = d.setdefault(date, {})
    day["date"] = date
    wd = datetime.now().weekday()
    trading = wd < 5
    now = _now_min()

    if mode in ("auto", "open") and trading:
        if "open" not in day and now >= 9 * 60 + 25:
            day["open"] = open_judgment(date)
            _save(d)

    if mode in ("auto", "snapshot") and trading:
        snaps = day.setdefault("snapshots", {})
        targets = [t] if (mode == "snapshot" and t) else list(SNAP_MIN.keys())
        for lbl, m in SNAP_MIN.items():
            if lbl in targets and lbl not in snaps and now >= m:
                snaps[lbl] = generate_snapshot(lbl, date)
                _save(d)

    if mode in ("auto", "review"):
        if datetime.now().hour >= 15 and "review" not in day:
            day["review"] = generate_review(date)
            _save(d)

    return day


if __name__ == "__main__":
    import sys
    mode = sys.argv[1] if len(sys.argv) > 1 else "auto"
    targ = sys.argv[2] if len(sys.argv) > 2 else None
    out = run_daily(mode, targ)
    print(json.dumps({"date": out.get("date"),
                      "has_open": "open" in out,
                      "snapshots": list((out.get("snapshots") or {}).keys()),
                      "has_review": "review" in out}, ensure_ascii=False, indent=2))
