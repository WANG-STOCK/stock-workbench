"""技术面信号引擎：基于趋势 / 均线 / MACD / KDJ / RSI / BOLL / 量能 的复合打分。

输出：action（强烈买入/买入/持有/减仓/卖出）、score（-100~100）、reasons（可读理由）、
      position（仓位建议：目标仓位%、股数、买卖差额与可读文案）。

纯规则，不预测未来，仅刻画当前技术面状态，供决策参考。所有规则权重可在 config.json
的 weights 中覆盖；仓位模型参数（资金、单票上限）同样可配。
"""

from core.indicators import compute_all

# ---------- 默认权重（每类规则的加减点；可用 config.json 覆盖） ----------
DEFAULT_WEIGHTS = {
    "trend_up": 8, "trend_down": -8, "trend_short_up": 3, "trend_short_down": -3,
    "ma_bull": 10, "ma_bear": -10,
    "macd_above": 5, "macd_below": -5,
    "macd_hist_pos": 3, "macd_hist_neg": -3,
    "macd_hist_up": 3, "macd_hist_down": -3,
    "macd_gold": 12, "macd_dead": -12,
    "kdj_oversold": 8, "kdj_overbought": -8,
    "kdj_gold_low": 10, "kdj_dead_high": -10,
    "rsi_oversold": 8, "rsi_overbought": -8,
    "rsi_bull": 4, "rsi_bear": -4,
    "boll_below": 6, "boll_above": -6,
    "boll_near_low": 3, "boll_near_up": -3,
    "vol_up": 6, "vol_down": -6, "vol_shrink_up": 2,
    "new_high": 5, "new_low": -5,
}

ACTION_THRESHOLDS = {
    "强烈买入": 50, "买入": 25, "持有": -24, "减仓": -49,
}

# ---------- 权重分类（供 UI 调节：7 大类，每类一个倍率 0~2） ----------
WEIGHT_CATEGORIES = {
    "趋势": ["trend_up", "trend_down", "trend_short_up", "trend_short_down", "new_high", "new_low"],
    "均线": ["ma_bull", "ma_bear"],
    "MACD": ["macd_above", "macd_below", "macd_hist_pos", "macd_hist_neg",
             "macd_hist_up", "macd_hist_down", "macd_gold", "macd_dead"],
    "KDJ": ["kdj_oversold", "kdj_overbought", "kdj_gold_low", "kdj_dead_high"],
    "RSI": ["rsi_oversold", "rsi_overbought", "rsi_bull", "rsi_bear"],
    "BOLL": ["boll_below", "boll_above", "boll_near_low", "boll_near_up"],
    "量能": ["vol_up", "vol_down", "vol_shrink_up"],
}

DEFAULT_MULTIPLIERS = {k: 1.0 for k in WEIGHT_CATEGORIES}


def expand_weights(multipliers=None):
    """把 7 大类倍率展开成逐规则权重字典，供 analyze() 使用。"""
    mult = dict(DEFAULT_MULTIPLIERS)
    if multipliers:
        for k, v in multipliers.items():
            if k in DEFAULT_MULTIPLIERS:
                try:
                    mult[k] = float(v)
                except (TypeError, ValueError):
                    pass
    out = {}
    for cat, keys in WEIGHT_CATEGORIES.items():
        m = mult.get(cat, 1.0)
        for k in keys:
            base = DEFAULT_WEIGHTS.get(k, 0)
            out[k] = round(base * m)
    return out


def _last_valid(seq, n=1):
    out = []
    for v in reversed(seq):
        if v is not None:
            out.append(v)
            if len(out) == n:
                break
    while len(out) < n:
        out.append(None)
    return list(reversed(out))


def _cross_up(a, b, lookback=3):
    n = len(a)
    for i in range(max(1, n - lookback), n):
        if a[i - 1] is not None and b[i - 1] is not None and a[i] is not None and b[i] is not None:
            if a[i - 1] <= b[i - 1] and a[i] > b[i]:
                return True
    return False


def _cross_down(a, b, lookback=3):
    n = len(a)
    for i in range(max(1, n - lookback), n):
        if a[i - 1] is not None and b[i - 1] is not None and a[i] is not None and b[i] is not None:
            if a[i - 1] >= b[i - 1] and a[i] < b[i]:
                return True
    return False


def _resolve_weights(weights):
    if not weights:
        return DEFAULT_WEIGHTS
    merged = dict(DEFAULT_WEIGHTS)
    merged.update(weights)
    return merged


def analyze(bars, weights=None):
    if len(bars) < 60:
        return {"ok": False, "msg": f"K线数量不足（{len(bars)} 根，需≥60根做技术判断）"}

    closes = [b["close"] for b in bars]
    highs = [b["high"] for b in bars]
    lows = [b["low"] for b in bars]
    vols = [b["volume"] for b in bars]
    ind = compute_all(bars)

    price = closes[-1]
    ma5, ma10, ma20, ma60 = (ind["ma5"][-1], ind["ma10"][-1], ind["ma20"][-1], ind["ma60"][-1])
    dif, dea, hist = ind["macd"]["dif"], ind["macd"]["dea"], ind["macd"]["hist"]
    K, D, J = ind["kdj"]["k"], ind["kdj"]["d"], ind["kdj"]["j"]
    rsi6, rsi12, rsi24 = ind["rsi"]["rsi6"], ind["rsi"]["rsi12"], ind["rsi"]["rsi24"]
    boll_up, boll_low, boll_mid = ind["boll"]["upper"][-1], ind["boll"]["lower"][-1], ind["boll"]["mid"][-1]
    vol_ma5 = ind["vol_ma5"][-1]

    W = _resolve_weights(weights)
    score = 0
    reasons = []

    def add(key, text):
        nonlocal score
        pts = W.get(key, 0)
        score += pts
        reasons.append({"pts": pts, "text": text})

    # ---- 趋势：价格 vs MA20 / MA60 ----
    if ma20 is not None and ma60 is not None:
        if price > ma20 and ma20 > ma60:
            add("trend_up", "价格站上 MA20 且 MA20>MA60，中期上升趋势")
        elif price < ma20 and ma20 < ma60:
            add("trend_down", "价格跌破 MA20 且 MA20<MA60，中期下降趋势")
        elif price > ma20:
            add("trend_short_up", "价格位于 MA20 上方，短期偏多")
        else:
            add("trend_short_down", "价格位于 MA20 下方，短期偏空")

    # ---- 均线多头/空头排列 ----
    if None not in (ma5, ma10, ma20, ma60):
        if ma5 > ma10 > ma20 > ma60:
            add("ma_bull", "MA5>MA10>MA20>MA60 多头排列，趋势强劲")
        elif ma5 < ma10 < ma20 < ma60:
            add("ma_bear", "MA5<MA10<MA20<MA60 空头排列，跌势明显")

    # ---- MACD ----
    if dif[-1] is not None and dea[-1] is not None:
        if dif[-1] > dea[-1]:
            add("macd_above", "MACD：DIF 在 DEA 上方（红柱区）")
        else:
            add("macd_below", "MACD：DIF 在 DEA 下方（绿柱区）")
        if hist[-1] is not None:
            if hist[-1] > 0:
                add("macd_hist_pos", "MACD 柱为正（多头动能）")
            else:
                add("macd_hist_neg", "MACD 柱为负（空头动能）")
            h2 = _last_valid(hist, 2)
            if len(h2) == 2 and h2[0] is not None and h2[1] is not None:
                if h2[1] > h2[0]:
                    add("macd_hist_up", "MACD 柱放大，动能增强")
                else:
                    add("macd_hist_down", "MACD 柱收窄，动能减弱")
        if _cross_up(dif, dea, 3):
            add("macd_gold", "MACD 金叉（DIF 上穿 DEA），买入信号")
        if _cross_down(dif, dea, 3):
            add("macd_dead", "MACD 死叉（DIF 下穿 DEA），卖出信号")

    # ---- KDJ ----
    if K[-1] is not None and D[-1] is not None:
        if K[-1] < 20 and D[-1] < 20:
            add("kdj_oversold", "KDJ 处于超卖区（K、D<20）")
        elif K[-1] > 80 and D[-1] > 80:
            add("kdj_overbought", "KDJ 处于超买区（K、D>80）")
        if _cross_up(K, D, 3) and K[-1] < 50:
            add("kdj_gold_low", "KDJ 低位金叉，反弹概率大")
        if _cross_down(K, D, 3) and K[-1] > 50:
            add("kdj_dead_high", "KDJ 高位死叉，回调风险高")

    # ---- RSI（以 RSI12 为主参考） ----
    r = rsi12[-1]
    if r is not None:
        if r < 30:
            add("rsi_oversold", f"RSI12={r:.1f} 进入超卖（<30）")
        elif r > 70:
            add("rsi_overbought", f"RSI12={r:.1f} 进入超买（>70）")
    if rsi6[-1] is not None and rsi12[-1] is not None and rsi24[-1] is not None:
        if rsi6[-1] > rsi12[-1] > rsi24[-1]:
            add("rsi_bull", "RSI 多头排列（6>12>24），短线强势")
        elif rsi6[-1] < rsi12[-1] < rsi24[-1]:
            add("rsi_bear", "RSI 空头排列（6<12<24），短线弱势")

    # ---- BOLL ----
    if boll_up is not None and boll_low is not None and boll_mid is not None:
        if price < boll_low:
            add("boll_below", "价格跌破 BOLL 下轨，超跌反弹候选")
        elif price > boll_up:
            add("boll_above", "价格突破 BOLL 上轨，短期超买")
        else:
            if price < boll_low * 1.02:
                add("boll_near_low", "价格贴近 BOLL 下轨，关注支撑")
            if price > boll_up * 0.98:
                add("boll_near_up", "价格贴近 BOLL 上轨，关注压力")

    # ---- 量能 ----
    if vol_ma5 and vol_ma5 > 0:
        ratio = vols[-1] / vol_ma5
        if ratio > 1.5:
            if closes[-1] >= closes[-2]:
                add("vol_up", f"放量上涨（量比 {ratio:.1f}），资金介入")
            else:
                add("vol_down", f"放量下跌（量比 {ratio:.1f}），抛压加重")
        elif ratio < 0.6 and closes[-1] >= closes[-2]:
            add("vol_shrink_up", "缩量小涨，惜售")

    # ---- 价格新高/新低 ----
    look = closes[-21:-1]
    if look and price > max(look):
        add("new_high", "创近 20 日新高，强势")
    elif look and price < min(look):
        add("new_low", "创近 20 日新低，弱势")

    score = max(-100, min(100, score))

    if score >= ACTION_THRESHOLDS["强烈买入"]:
        action = "强烈买入"
    elif score >= ACTION_THRESHOLDS["买入"]:
        action = "买入"
    elif score >= ACTION_THRESHOLDS["持有"]:
        action = "持有"
    elif score >= ACTION_THRESHOLDS["减仓"]:
        action = "减仓"
    else:
        action = "卖出"

    return {
        "ok": True,
        "action": action,
        "score": score,
        "reasons": reasons,
        "price": price,
        "prev_close": closes[-2] if len(closes) > 1 else None,
        "indicators": {
            "ma": {"ma5": ma5, "ma10": ma10, "ma20": ma20, "ma60": ma60},
            "macd": {"dif": dif[-1], "dea": dea[-1], "hist": hist[-1]},
            "kdj": {"k": K[-1], "d": D[-1], "j": J[-1]},
            "rsi": {"rsi6": rsi6[-1], "rsi12": rsi12[-1], "rsi24": rsi24[-1]},
            "boll": {"mid": boll_mid, "upper": boll_up, "lower": boll_low},
        },
        "bars_count": len(bars),
    }


def position_advice(score, action, price, capital=100000.0, max_single=0.25,
                    current_shares=0, lot=100):
    """根据评分与动作，给出可执行的仓位建议（规则化、非个性化投顾）。

    - capital：可用于该标的总资金（元）
    - max_single：单票最大仓位占 capital 的比例（如 0.25 = 25%）
    - current_shares：当前持仓股数（默认 0）
    返回：目标仓位%、目标股数、买卖差额、可读建议、备注。
    """
    cur_cap = current_shares * price
    cur_pct = (cur_cap / capital) if capital > 0 and price > 0 else 0.0

    if action == "强烈买入":
        target_pct = max_single
    elif action == "买入":
        target_pct = max_single * 0.6
    elif action == "持有":
        target_pct = cur_pct  # 维持现状
    elif action == "减仓":
        target_pct = (cur_pct * 0.5) if current_shares > 0 else 0.0
    else:  # 卖出
        target_pct = 0.0

    target_cap = capital * target_pct
    target_shares = int(target_cap // (price * lot)) * lot if (price > 0 and lot > 0) else 0
    delta = target_shares - current_shares

    note = ""
    # 买入信号但资金连 1 手都买不起
    if action in ("强烈买入", "买入") and target_shares == 0 and current_shares == 0:
        one_lot = price * lot
        if one_lot > capital:
            note = f"信号偏多，但资金（¥{capital:,.0f}）不足以买入 1 手（需 ¥{one_lot:,.0f}），建议增资或换低价标的/等回调"
        else:
            target_shares = lot
            delta = lot
            note = "资金充裕，先建 1 手底仓试探"
    # 减仓但无持仓
    if action == "减仓" and current_shares == 0:
        note = "当前无持仓，无需减仓"
    # 卖出且无持仓
    if action == "卖出" and current_shares == 0:
        note = "当前无持仓，无需卖出"

    if delta > 0:
        verb = "买入"
        text = f"建议{verb}约 {delta} 股（≈¥{delta * price:,.0f}），将仓位由 {cur_pct*100:.1f}% 提至 {target_pct*100:.1f}%"
    elif delta < 0:
        verb = "卖出"
        text = f"建议{verb}约 {-delta} 股（≈¥{-delta * price:,.0f}），将仓位由 {cur_pct*100:.1f}% 降至 {target_pct*100:.1f}%"
    elif action == "持有":
        text = "维持现有仓位，不新建、不加仓、不减仓，等待信号变化"
    else:
        # 买入/强烈买入 但 delta==0（资金不足或无持仓可减）
        text = note if note else "目标仓位与当前一致，暂不操作"

    return {
        "action": action,
        "target_pct": round(target_pct, 4),
        "target_shares": target_shares,
        "current_shares": current_shares,
        "delta_shares": delta,
        "target_cash": round(target_cap, 2),
        "delta_cash": round(delta * price, 2),
        "suggestion": text,
        "note": note,
    }


def scan_flags(bars):
    """返回用于策略选股的多空特征标记（布尔）。bars 不足时返回空字典。"""
    if len(bars) < 60:
        return {}
    closes = [b["close"] for b in bars]
    highs = [b["high"] for b in bars]
    lows = [b["low"] for b in bars]
    vols = [b["volume"] for b in bars]
    ind = compute_all(bars)
    ma5, ma10, ma20, ma60 = (ind["ma5"][-1], ind["ma10"][-1], ind["ma20"][-1], ind["ma60"][-1])
    dif, dea, hist = ind["macd"]["dif"], ind["macd"]["dea"], ind["macd"]["hist"]
    K, D = ind["kdj"]["k"], ind["kdj"]["d"]
    price = closes[-1]
    vol_ma5 = ind["vol_ma5"][-1]

    flags = {}
    flags["ma_bull"] = None not in (ma5, ma10, ma20, ma60) and (ma5 > ma10 > ma20 > ma60)
    flags["macd_gold"] = _cross_up(dif, dea, 3)
    flags["macd_red"] = dif[-1] is not None and dea[-1] is not None and dif[-1] > dea[-1]
    look = closes[-21:-1]
    flags["breakout"] = bool(look) and price >= max(look)
    flags["new_low"] = bool(look) and price <= min(look)
    flags["kdj_gold_low"] = _cross_up(K, D, 3) and K[-1] is not None and K[-1] < 50
    flags["kdj_oversold"] = K[-1] is not None and D[-1] is not None and K[-1] < 20 and D[-1] < 20
    # BOLL 下轨附近
    boll = ind["boll"]
    boll_low = boll["lower"][-1]
    flags["boll_near_low"] = bool(boll_low) and price <= boll_low * 1.03
    # 缩量
    ratio_v = (vols[-1] / vol_ma5) if (vol_ma5 and vol_ma5 > 0) else 1.0
    flags["low_volume"] = ratio_v < 0.7
    # 均线粘合
    if None not in (ma5, ma10, ma20, ma60) and ma20:
        spread = (max(ma5, ma10, ma20, ma60) - min(ma5, ma10, ma20, ma60)) / ma20
        flags["ma_converge"] = spread < 0.03
    else:
        flags["ma_converge"] = False
    if vol_ma5 and vol_ma5 > 0:
        ratio = vols[-1] / vol_ma5
        flags["volume_surge"] = ratio > 1.8 and closes[-1] >= closes[-2]
        flags["volume_surge_down"] = ratio > 1.8 and closes[-1] < closes[-2]
    else:
        flags["volume_surge"] = flags["volume_surge_down"] = False
    a = analyze(bars)
    flags["score"] = a["score"] if a.get("ok") else 0
    flags["action"] = a["action"] if a.get("ok") else "持有"
    return flags


# 策略 -> 命中条件
STRATEGY_PREDICATES = {
    "composite": lambda f: f.get("score", 0) >= 25,                       # 综合买入及以上
    "ma_bull": lambda f: bool(f.get("ma_bull")),                          # 均线多头排列
    "golden_cross": lambda f: bool(f.get("macd_gold")) or bool(f.get("kdj_gold_low")),  # 金叉
    "breakout": lambda f: bool(f.get("breakout")) and not bool(f.get("new_low")),        # 创 20 日新高
    "volume_surge": lambda f: bool(f.get("volume_surge")),                # 放量上涨
    "low_volume_rebound": lambda f: (bool(f.get("kdj_oversold")) or bool(f.get("boll_near_low")))
                                    and bool(f.get("low_volume")) and not bool(f.get("new_low")),  # 缩量企稳反弹
    "ma_converge_breakout": lambda f: bool(f.get("ma_converge")) and bool(f.get("breakout")),   # 均线粘合突破
}
STRATEGY_LABELS = {
    "composite": "综合评分（买入及以上）",
    "ma_bull": "均线多头排列",
    "golden_cross": "MACD/KDJ 金叉",
    "breakout": "突破 20 日新高",
    "volume_surge": "放量上涨",
    "low_volume_rebound": "缩量企稳反弹",
    "ma_converge_breakout": "均线粘合突破",
}
