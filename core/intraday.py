"""盘中实时操作建议：基于 5 分钟 K 线 + 实时价，给"该不该卖/买"的明确动作。

设计要点（来自用户反馈）：
  - 用分时走势（不是日 K）做判断，不然没有时效性，看一眼就来不及；
  - 拉升/回落转折点要识别（"拉升到6个点跌到4个点我该不该卖"）；
  - 输出 action / urgency / target_price / stop_loss / reasons，前端可高频刷新。

核心数据：
  - quote: realtime 行情 {price, prev_close, open, high, low, volume, change_pct, time}
  - bars_5m: get_kline(code, "5m", 48) — 含当日全部 5min K 线
"""
from __future__ import annotations

from typing import Dict, List, Optional


# ------------------------------------------------------------------
# 5 分钟 K 线技术指标（自己写，只算最后 N 根，开销极小）
# ------------------------------------------------------------------
def _ema(seq, n):
    if not seq:
        return []
    k = 2.0 / (n + 1)
    out = [seq[0]]
    for x in seq[1:]:
        out.append(out[-1] + k * (x - out[-1]))
    return out


def _last(arr, i=0):
    try:
        return arr[-1 - i]
    except (IndexError, TypeError):
        return None


def compute_5m_indicators(bars: List[Dict]) -> Dict:
    """输入 bars_5m，输出最近几根的关键指标（MACD/KDJ/RSI/BOLL/MA5/MA10/量比）。"""
    if not bars or len(bars) < 5:
        return {}
    closes = [b["close"] for b in bars]
    vols = [b.get("volume", 0) or 0 for b in bars]

    # MA
    ma5 = sum(closes[-5:]) / 5.0
    ma10 = sum(closes[-10:]) / 10.0 if len(closes) >= 10 else ma5
    ma20 = sum(closes[-20:]) / 20.0 if len(closes) >= 20 else ma10

    # MACD
    ema12 = _ema(closes, 12)
    ema26 = _ema(closes, 26)
    dif_series = [a - b for a, b in zip(ema12, ema26)]
    dea_series = _ema(dif_series, 9)
    macd_series = [2 * (a - b) for a, b in zip(dif_series, dea_series)]
    dif = _last(dif_series) or 0
    dea = _last(dea_series) or 0
    macd = _last(macd_series) or 0
    macd_prev = macd_series[-2] if len(macd_series) >= 2 else macd
    # BOLL(20, 2)
    last20 = closes[-20:] if len(closes) >= 20 else closes
    mid = sum(last20) / len(last20)
    var = sum((x - mid) ** 2 for x in last20) / len(last20)
    boll_std = var ** 0.5
    boll_upper = mid + 2 * boll_std
    boll_lower = mid - 2 * boll_std

    # KDJ(9,3,3)
    k_vals, d_vals, j_vals = [], [], []
    k_prev = 50.0
    d_prev = 50.0
    recent = bars[-min(60, len(bars)):]
    for i, b in enumerate(recent):
        hv = max(x["high"] for x in recent[max(0, i - 8):i + 1])
        lv = min(x["low"] for x in recent[max(0, i - 8):i + 1])
        cv = b["close"]
        rsv = (cv - lv) / (hv - lv) * 100 if hv > lv else 50
        k = 2 / 3 * k_prev + 1 / 3 * rsv
        d = 2 / 3 * d_prev + 1 / 3 * k
        j = 3 * k - 2 * d
        k_vals.append(k); d_vals.append(d); j_vals.append(j)
        k_prev, d_prev = k, d
    k = _last(k_vals)
    d = _last(d_vals)
    j = _last(j_vals)
    kdj_j_prev = j_vals[-2] if len(j_vals) >= 2 else j
    kdj_turn_down = (j is not None) and (j < kdj_j_prev - 1)
    kdj_turn_up = (j is not None) and (j > kdj_j_prev + 1)

    # RSI(12)
    gains, losses = [], []
    for i in range(1, len(closes)):
        chg = closes[i] - closes[i - 1]
        gains.append(max(chg, 0)); losses.append(max(-chg, 0))
    gains12 = gains[-12:] if len(gains) >= 12 else gains
    losses12 = losses[-12:] if len(losses) >= 12 else losses
    avg_gain = sum(gains12) / max(len(gains12), 1)
    avg_loss = sum(losses12) / max(len(losses12), 1)
    rs = avg_gain / (avg_loss + 1e-9)
    rsi = 100 - 100 / (1 + rs)

    # 量能：最近 5 根均量 / 前 20 根均量
    last5_vol = sum(vols[-5:]) / 5
    prev20_vol = sum(vols[-25:-5]) / 20 if len(vols) >= 25 else last5_vol
    vol_ratio = last5_vol / (prev20_vol + 1e-9)

    return {
        "ma5": ma5, "ma10": ma10, "ma20": ma20,
        "dif": dif, "dea": dea, "macd": macd, "macd_prev": macd_prev,
        "macd_red_shrinking": (macd > 0) and (macd < macd_prev),
        "boll_mid": mid, "boll_upper": boll_upper, "boll_lower": boll_lower,
        "k": k, "d": d, "j": j, "j_prev": kdj_j_prev,
        "kdj_turn_down": kdj_turn_down, "kdj_turn_up": kdj_turn_up,
        "kdj_overbought": (j is not None) and j > 90,
        "kdj_oversold": (j is not None) and j < 10,
        "rsi": rsi,
        "vol_ratio": vol_ratio,
        "last_bar_close": closes[-1],
        "last_bar_vol": vols[-1],
    }


# ------------------------------------------------------------------
# 场景识别 + 操作决策（核心）
# ------------------------------------------------------------------
def _scenario(quote: Dict, indicators: Dict, bars_5m: List[Dict], prev_close: float) -> str:
    """先判场景，再决策。"""
    if not quote or not indicators or prev_close <= 0:
        return "数据不足"

    cur = quote.get("price")
    day_high = quote.get("high") or cur
    day_low = quote.get("low") or cur
    cur_pct = (cur - prev_close) / prev_close * 100
    high_pct = (day_high - prev_close) / prev_close * 100
    low_pct = (day_low - prev_close) / prev_close * 100
    pullback = (day_high - cur) / prev_close * 100 if cur < day_high else 0

    # 探底回升·强势多头：盘中曾深跌（≤-2%），当前强势收回并大涨（≥+3%）
    #   —— 即"早盘下杀→午后拉起"，属强反转日，应看多而非止盈
    if low_pct <= -2.0 and cur_pct >= 3.0:
        return "探底回升·强势多头"
    # 急涨后回落：最大涨幅>=3% 且 已回落>=0.5%
    if high_pct >= 3.0 and pullback >= 0.5 and cur_pct >= 1.0:
        return "急涨后回落"
    # 急涨中：最大涨幅>=3% 且 未明显回落 或 仍在创新高
    if high_pct >= 3.0 and cur_pct >= high_pct - 0.5:
        return "急涨中（创新高）"
    # 稳步上涨：当日在 1% 以上，MACD 红柱
    if cur_pct >= 1.0 and indicators.get("macd", 0) > 0:
        return "稳步上涨"
    # 急跌中
    if cur_pct <= -2.0 and cur <= day_low + (day_high - day_low) * 0.2:
        return "急跌中"
    # 急跌后反弹：当日最低 < -2% 且 当前较最低点反弹 >= 1%
    rebound = (cur - day_low) / prev_close * 100 if cur > day_low else 0
    if low_pct <= -2.0 and rebound >= 1.0 and cur_pct <= 0:
        return "急跌后反弹"
    # 低位反弹
    if cur_pct < 0 and rebound >= 1.5:
        return "低位反弹"
    # 高位震荡
    if abs(cur_pct) < 1.0 and high_pct >= 2.0:
        return "高位震荡"
    # 低开震荡
    if abs(cur_pct) < 1.0 and low_pct <= -1.0:
        return "低位震荡"
    return "中性整理"


def _decide(scenario: str, quote: Dict, indicators: Dict, prev_close: float) -> Dict:
    """场景 → 操作建议（含原因链 + 价 + 止损）。"""
    cur = quote.get("price", 0)
    day_high = quote.get("high") or cur
    day_low = quote.get("low") or cur
    cur_pct = (cur - prev_close) / prev_close * 100 if prev_close else 0
    high_pct = (day_high - prev_close) / prev_close * 100 if prev_close else 0
    low_pct = (day_low - prev_close) / prev_close * 100 if prev_close else 0
    pullback = (day_high - cur) / prev_close * 100 if cur < day_high else 0
    reasons: List[str] = []
    j = indicators.get("j")
    kdj_overbought = indicators.get("kdj_overbought")
    kdj_oversold = indicators.get("kdj_oversold")
    kdj_turn_down = indicators.get("kdj_turn_down")
    kdj_turn_up = indicators.get("kdj_turn_up")
    macd_red_shrinking = indicators.get("macd_red_shrinking")
    vol_ratio = indicators.get("vol_ratio", 1.0)
    macd = indicators.get("macd", 0)
    rsi = indicators.get("rsi", 50)
    ma5 = indicators.get("ma5", cur)

    action = "持有观察"
    urgency = "看后续"
    target_price = None
    target_type = ""
    stop_loss = None
    action_color = "#1971c2"  # 默认蓝

    if scenario == "探底回升·强势多头":
        # 王总反馈：太极这种"早上低点→现在涨很多"的强反转日，不该给"立即卖出"
        #   —— 这是早盘下杀后强势拉起的多头，应看多 / 回踩可加仓
        reasons.append(f"盘中探底 {low_pct:.2f}% 后强势拉起，当前 +{cur_pct:.2f}%，多头动能强")
        action = "持有看多"
        urgency = "看后续"
        action_color = "#2b8a3e"
        if (j is not None and 60 < (j or 0) < 92) and macd > 0 and not kdj_overbought and vol_ratio >= 1.0:
            action = "可回踩加仓"
            urgency = "回踩时"
            target_price = round(cur * 0.985, 2)
            target_type = "加仓"
            stop_loss = round(cur * 0.95, 2)
            reasons.append("动能未竭（KDJ 未极超买、MACD 红柱），回踩可加仓追涨")
        elif kdj_overbought and (j is not None and j >= 95):
            action = "持有看多"
            urgency = "看后续"
            reasons.append("但 KDJ 已极超买，防回落，不追高（回踩买点再加）")
        else:
            action = "持有看多"
        action_color = "#2b8a3e"
    elif scenario == "急涨后回落":
        # 主要卖出场景：止盈
        reasons.append(f"日内最大涨幅 +{high_pct:.2f}%，当前 +{cur_pct:.2f}%，已回落 {pullback:.2f}%")
        if (j is not None and j >= 95) or (kdj_overbought and kdj_turn_down):
            action = "立即止盈卖出"
            urgency = "立即"
            target_price = round(day_high * 0.995, 2)  # 回落到前日高点的微折让位
            target_type = "止盈"
            stop_loss = round(cur * 0.985, 2)  # 已大涨2%止损
            reasons.append(f"KDJ J={j:.1f} 超买且拐头向下")
            action_color = "#c92a2a"
        elif (j is not None and j >= 90):
            action = "5分钟内止盈"
            urgency = "5分钟内"
            target_price = round(day_high * 0.995, 2)
            target_type = "止盈"
            stop_loss = round(cur * 0.985, 2)
            reasons.append(f"KDJ J={j:.1f} 高位，但未拐头")
            action_color = "#e8590c"
        elif macd_red_shrinking:
            action = "分批止盈"
            urgency = "5分钟内"
            target_price = round(cur * 1.005, 2)
            target_type = "短线止盈"
            stop_loss = round(cur * 0.99, 2)
            reasons.append(f"MACD 红柱缩短（动能减弱）")
            action_color = "#e8590c"
        else:
            action = "持有观察"
            urgency = "看后续5分钟"
            reasons.append("缩量 + MACD 仍扩张，可再等一根")
            action_color = "#1971c2"
        # 量能追加理由
        if vol_ratio >= 2.0:
            reasons.append(f"放量（量比 {vol_ratio:.2f}）")
        elif vol_ratio <= 0.6:
            reasons.append(f"缩量（量比 {vol_ratio:.2f}），上攻乏力")
    elif scenario == "急涨中（创新高）":
        action = "持有观察"
        urgency = "看后续"
        reasons.append(f"仍在创新高 +{cur_pct:.2f}%")
        if macd_red_shrinking:
            action = "5分钟内止盈"
            urgency = "5分钟内"
            target_price = round(day_high * 0.99, 2)
            target_type = "止盈"
            stop_loss = round(cur * 0.985, 2)
            reasons.append("但 MACD 红柱缩短，注意动能减弱")
            action_color = "#e8590c"
        if rsi >= 85:
            reasons.append(f"RSI={rsi:.0f} 极强超买")
        action_color = "#1971c2"
    elif scenario == "稳步上涨":
        action = "持有观察"
        urgency = "看后续"
        reasons.append(f"稳步上涨 +{cur_pct:.2f}%，MACD 红柱")
        # 新增（王总反馈）：强势拉升但未极超买 → 给出"可加仓追涨"
        if (j is not None and 60 < (j or 0) < 95) and macd > 0 and vol_ratio >= 1.2 and cur_pct >= 1.5 and not macd_red_shrinking:
            action = "可加仓追涨"
            urgency = "立即"
            target_price = round(cur * 1.012, 2)
            target_type = "追涨"
            stop_loss = round(ma5 * 0.995, 2)
            reasons.append(f"强势拉升 +{cur_pct:.2f}%（KDJ J={j:.0f}）、放量（量比 {vol_ratio:.2f}）、MACD 仍扩张")
            action_color = "#2b8a3e"
        elif macd_red_shrinking and vol_ratio < 1.0:
            action = "分批止盈"
            urgency = "5分钟内"
            target_price = round(cur * 1.008, 2)
            target_type = "短线止盈"
            stop_loss = round(ma5 * 0.99, 2)
            reasons.append(f"MACD 红柱缩短 + 缩量（量比 {vol_ratio:.2f}）")
            action_color = "#e8590c"
        action_color = "#2b8a3e" if action == "可加仓追涨" else "#1971c2"
    elif scenario == "急跌中":
        action = "暂不加仓"
        urgency = "立即"
        reasons.append(f"急跌 {cur_pct:.2f}%，放量下杀")
        if (j is not None and j < 20) and vol_ratio > 1.5:
            reasons.append(f"但 KDJ J={j:.0f} 严重超卖，可少量试探")
        stop_loss = round(cur * 0.97, 2)
        action_color = "#c92a2a"
    elif scenario == "急跌后反弹":
        reasons.append(f"从最低点反弹 {(cur - day_low) / prev_close * 100:.2f}%")
        if (j is not None and j < 30):
            action = "低吸加仓"
            urgency = "5分钟内"
            target_price = round(day_low * 1.01, 2)
            target_type = "低吸"
            stop_loss = round(day_low * 0.985, 2)
            reasons.append(f"KDJ J={j:.0f} 超卖区域")
            action_color = "#2b8a3e"
        elif kdj_turn_up and macd > 0:
            action = "可分批低吸"
            urgency = "看后续"
            target_price = round(day_low * 1.015, 2)
            target_type = "试探"
            stop_loss = round(day_low * 0.985, 2)
            reasons.append("KDJ 拐头向上 + MACD 转正")
            action_color = "#2b8a3e"
        else:
            action = "观望"
            urgency = "看后续"
            action_color = "#1971c2"
    elif scenario == "低位反弹":
        reasons.append(f"低位反弹 {cur_pct:.2f}%")
        if kdj_oversold:
            action = "低吸加仓"
            urgency = "5分钟内"
            target_price = round(ma5 * 0.995, 2)
            target_type = "低吸"
            stop_loss = round(day_low * 0.985, 2)
            reasons.append(f"KDJ J={j:.0f} 严重超卖")
            action_color = "#2b8a3e"
        else:
            action = "持有观察"
            urgency = "看后续"
            action_color = "#1971c2"
    elif scenario == "高位震荡":
        action = "持有观察"
        urgency = "看后续"
        reasons.append(f"高位震荡 +{cur_pct:.2f}%，等方向")
        if rsi >= 80 and macd_red_shrinking:
            action = "分批止盈"
            urgency = "5分钟内"
            target_price = round(day_high * 0.99, 2)
            target_type = "止盈"
            stop_loss = round(day_low * 1.005, 2)
            reasons.append("RSI 高位 + 红柱缩短")
            action_color = "#e8590c"
        action_color = "#1971c2"
    elif scenario == "低位震荡":
        action = "观望"
        urgency = "看后续"
        reasons.append(f"低位震荡 {cur_pct:.2f}%，等企稳")
        if kdj_oversold and vol_ratio < 0.8:
            action = "低吸加仓"
            urgency = "5分钟内"
            target_price = round(day_low * 1.01, 2)
            target_type = "低吸"
            stop_loss = round(day_low * 0.985, 2)
            reasons.append(f"缩量 + KDJ J={j:.0f} 超卖")
            action_color = "#2b8a3e"
        action_color = "#1971c2"
    else:
        reasons.append(f"分时中性，可继续观察")
        action_color = "#868e96"

    return {
        "action": action,
        "urgency": urgency,
        "action_color": action_color,
        "target_price": target_price,
        "target_type": target_type,
        "stop_loss": stop_loss,
        "reasons": reasons,
    }


def intraday_advice(quote: Dict, bars_5m: List[Dict], prev_close: Optional[float] = None) -> Dict:
    """主入口。

    参数:
      quote: 实时行情 {price, prev_close, open, high, low, volume, ...}
      bars_5m: 5min K 线 list
      prev_close: 昨收（可选，quote 里也有；不一致时取这里）

    返回:
      Dict 含 scenario, action, urgency, target_price, stop_loss, reasons,
      metrics（指标快照）, ts
    """
    cur = quote.get("price")
    pc = prev_close if prev_close else quote.get("prev_close") or cur
    if not cur or not pc:
        return {"error": "无实时价/昨收", "scenario": "数据不足"}

    indicators = compute_5m_indicators(bars_5m)
    if not indicators:
        return {"error": "5min K线数据不足", "scenario": "数据不足"}

    scenario = _scenario(quote, indicators, bars_5m, pc)
    decision = _decide(scenario, quote, indicators, pc)

    # 数据快照
    metrics = {
        "now_pct": round((cur - pc) / pc * 100, 2),
        "day_high_pct": round(((quote.get("high") or cur) - pc) / pc * 100, 2),
        "day_low_pct": round(((quote.get("low") or cur) - pc) / pc * 100, 2),
        "pullback_pct": round(((quote.get("high") or cur) - cur) / pc * 100, 2),
        "rise_5m_pct": round(_pct(bars_5m, 1), 2),
        "rise_15m_pct": round(_pct(bars_5m, 3), 2),
        "rise_60m_pct": round(_pct(bars_5m, 12), 2),
        "kdj_j": round(indicators["j"], 1) if indicators.get("j") is not None else None,
        "kdj_status": (
            "超买" if indicators.get("kdj_overbought")
            else "超卖" if indicators.get("kdj_oversold")
            else "正常"
        ),
        "kdj_turn": "下拐" if indicators.get("kdj_turn_down") else (
            "上拐" if indicators.get("kdj_turn_up") else "平稳"
        ),
        "macd": round(indicators["macd"], 4),
        "macd_status": "红柱缩" if indicators.get("macd_red_shrinking") else (
            "红柱扩" if indicators["macd"] > 0 else "绿柱"
        ),
        "rsi": round(indicators["rsi"], 1),
        "vol_ratio": round(indicators["vol_ratio"], 2),
        "boll_pos": _boll_pos(cur, indicators),
    }

    return {
        "scenario": scenario,
        "action": decision["action"],
        "urgency": decision["urgency"],
        "action_color": decision["action_color"],
        "target_price": decision["target_price"],
        "target_type": decision["target_type"],
        "stop_loss": decision["stop_loss"],
        "reasons": decision["reasons"],
        "metrics": metrics,
        "price": cur,
        "prev_close": pc,
        "ts": quote.get("time"),
    }


def _pct(bars: List[Dict], n: int) -> float:
    """最近 n 根 K 线的累计涨跌幅（收盘对收盘）。"""
    if not bars or len(bars) <= n:
        return 0.0
    cur = bars[-1]["close"]
    base = bars[-(n + 1)]["close"]
    return (cur - base) / base * 100 if base else 0.0


def _boll_pos(cur, indicators):
    if not indicators:
        return "—"
    up = indicators.get("boll_upper") or 0
    mid = indicators.get("boll_mid") or 0
    low = indicators.get("boll_lower") or 0
    if cur >= up:
        return "上轨外"
    if cur >= mid + (up - mid) * 0.5:
        return "上半轨"
    if cur >= mid - (mid - low) * 0.5:
        return "中轨附近"
    if cur >= low:
        return "下半轨"
    return "下轨外"
