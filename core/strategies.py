"""core/strategies.py  ——  两套短线量化策略（r31）

模式一 · 隔夜抢仓（overnight_score）
    当天买入、持股 1-3 天；盈利 +3%/+5%/+8% 分批止盈；跌破买入价 2-3% 止损。
    逻辑：日线定方向 + 30/60 分钟找买点（双周期共振）。

模式二 · 日内做 T（intraday_t_signal）
    已有底仓的标的，当天低买高卖、收盘前平仓，降低持仓成本。
    逻辑：1 分钟主信号 + 5 分钟过滤（VWAP / 量能脉冲 / 14:50 强制平仓）。

全部为纯计算函数，K线由 server 传入，便于单元复用与离线回测。
依赖：core.indicators.compute_all / sma
"""


import datetime
from core.indicators import compute_all, sma


# ---------------- 小工具 ----------------
def _last(arr, default=None):
    """取列表最后一个非 None 值"""
    if arr and len(arr) > 0:
        for v in reversed(arr):
            if v is not None:
                return v
    return default


def _cross_up(a, b, n=2):
    """a 在最近 n 根内上穿 b（金叉）"""
    if not a or not b or len(a) < n + 1 or len(b) < n + 1:
        return False
    try:
        for i in range(-n, 0):
            if a[i] is None or b[i] is None or a[i - 1] is None or b[i - 1] is None:
                continue
            if a[i - 1] <= b[i - 1] and a[i] > b[i]:
                return True
    except Exception:
        pass
    return False


def _cross_down(a, b, n=2):
    """a 在最近 n 根内下穿 b（死叉）"""
    if not a or not b or len(a) < n + 1 or len(b) < n + 1:
        return False
    try:
        for i in range(-n, 0):
            if a[i] is None or b[i] is None or a[i - 1] is None or b[i - 1] is None:
                continue
            if a[i - 1] >= b[i - 1] and a[i] < b[i]:
                return True
    except Exception:
        pass
    return False


def _vwap(bars):
    """成交量加权均价（近似 VWAP）"""
    num = 0.0
    den = 0.0
    for b in bars:
        v = b.get("volume") or 0
        c = b.get("close") or 0
        if v and c:
            num += c * v
            den += v
    return num / den if den > 0 else None


def _vol_ratio_recent(vols, back=1):
    """最近一根量 / 前 back 根均量"""
    if not vols or len(vols) < back + 1:
        return 1.0
    tail = vols[-(back + 1):-1]
    recent = vols[-1]
    base = sum(tail) / max(1, len(tail))
    if base > 0 and recent:
        return recent / base
    return 1.0


# ---------------- 模式一 · 隔夜抢仓 ----------------
def overnight_score(code, bars_day, bars_30m=None, bars_60m=None,
                    price=None, prev_close=None, name=""):
    """隔夜抢仓评分（持股 1-3 天）。

    入参：
        code/name   : 股票代码/名称
        bars_day    : 日线 K线（≥60 根）
        bars_30m/60m: 30/60 分钟 K线（用于买点共振，可缺）
        price/prev_close: 实时价/昨收（缺则取日线末根）
    返回 dict（ok=True 时含 score/action/entry/stop_loss/take_profit/...）
    """
    if not bars_day or len(bars_day) < 60:
        return {"ok": False, "mode": "overnight",
                "msg": f"日线不足{len(bars_day) if bars_day else 0}根（需≥60）"}
    closes = [b["close"] for b in bars_day if b.get("close") is not None]
    if len(closes) < 60:
        return {"ok": False, "mode": "overnight", "msg": "日线收盘价不足"}

    ind = compute_all(bars_day)
    price = price if price else closes[-1]
    prev_close = prev_close if prev_close else (closes[-2] if len(closes) > 1 else price)

    ma5 = _last(sma(closes, 5))
    ma10 = _last(sma(closes, 10))
    ma20 = _last(sma(closes, 20))
    ma60 = _last(sma(closes, 60)) if len(closes) >= 60 else None

    dif = ind["macd"]["dif"]
    dea = ind["macd"]["dea"]
    hist = ind["macd"]["hist"]
    K = ind["kdj"]["k"]
    D = ind["kdj"]["d"]
    J = ind["kdj"]["j"]
    rsi6 = ind["rsi"]["rsi6"]
    rsi12 = ind["rsi"]["rsi12"]
    up = ind["boll"]["upper"]
    mid = ind["boll"]["mid"]
    low = ind["boll"]["lower"]

    vols = [b.get("volume") or 0 for b in bars_day[-6:]]
    vol_ratio = _vol_ratio_recent(vols, 5)
    roc5 = (closes[-1] - closes[-6]) / closes[-6] * 100 if len(closes) >= 6 and closes[-6] else 0

    hit = []
    miss = []
    score = 0

    # ① 趋势：价 vs MA20 / MA60
    if ma20 and ma60:
        if price > ma20 and ma20 > ma60:
            score += 20
            hit.append("中期上升趋势（价>MA20>MA60）")
        elif price < ma20 and ma20 < ma60:
            score -= 5
            miss.append("中期下降趋势")
        else:
            score += 8
            hit.append("趋势震荡偏" + ("多" if price > ma20 else "空"))
    else:
        score += 8

    # ② 均线多头排列
    if ma5 and ma10 and ma20 and ma5 > ma10 > ma20:
        score += 15
        hit.append("5/10/20 多头排列")
        if price > ma5:
            score += 5
            hit.append("价在 MA5 上方")
    elif ma5 and ma10 and ma5 > ma10:
        score += 7
    else:
        miss.append("均线未多头")

    # ③ MACD 日线
    macd_red = _last(dif) is not None and _last(dea) is not None and _last(dif) > _last(dea)
    macd_gold = _cross_up(dif, dea, 5)
    if macd_gold:
        score += 20
        hit.append("MACD 日线金叉")
    elif macd_red:
        score += 12
        hit.append("MACD 红柱（多头动能）")
    else:
        miss.append("MACD 偏弱")

    # ④ KDJ
    jv = _last(J)
    kv = _last(K)
    dv = _last(D)
    kdj_gold_low = _cross_up(K, D, 3) and (kv is not None and kv < 50)
    if jv is not None and jv < 20:
        score += 15
        hit.append(f"KDJ J={jv:.0f} 超卖")
    elif kdj_gold_low:
        score += 12
        hit.append("KDJ 低位金叉")
    elif jv is not None and jv > 90:
        score -= 8
        miss.append(f"KDJ J={jv:.0f} 超买")
    else:
        score += 4

    # ⑤ RSI：30-50 转头向上
    r = _last(rsi12)
    if r is not None:
        if 30 <= r <= 50 and (_last(rsi6) is not None and _last(rsi12) is not None
                              and _last(rsi6) > _last(rsi12)):
            score += 10
            hit.append(f"RSI12={r:.0f} 转强")
        elif r > 70:
            score -= 6
            miss.append(f"RSI12={r:.0f} 超买")
        elif r < 30:
            score += 6
            hit.append(f"RSI12={r:.0f} 超卖")
        else:
            score += 3

    # ⑥ BOLL 收回
    lu = _last(up)
    ll = _last(low)
    lm = _last(mid)
    if lu and ll and lm:
        if price < ll * 1.02:
            score += 8
            hit.append("贴近 BOLL 下轨（超跌）")
        elif price > lu * 0.98:
            score -= 6
            miss.append("贴近 BOLL 上轨（超买）")
        elif price < lm * 1.03:
            score += 6
            hit.append("收回 BOLL 中轨下方")
        else:
            score += 3

    # ⑦ 量能
    if vol_ratio >= 1.5:
        score += 10
        hit.append(f"量能放大{vol_ratio:.1f}倍")
    elif vol_ratio >= 1.0:
        score += 4
    else:
        miss.append(f"量能萎缩{vol_ratio:.1f}倍")

    # 30/60m 买点共振（加分项）
    if bars_30m and len(bars_30m) >= 30:
        i30 = compute_all(bars_30m)
        if _cross_up(i30["macd"]["dif"], i30["macd"]["dea"], 3):
            score += 6
            hit.append("30m MACD 金叉（买点共振）")
        if _cross_up(i30["kdj"]["k"], i30["kdj"]["d"], 3):
            score += 4
            hit.append("30m KDJ 金叉")
    if bars_60m and len(bars_60m) >= 30:
        i60 = compute_all(bars_60m)
        if _cross_up(i60["macd"]["dif"], i60["macd"]["dea"], 3):
            score += 4
            hit.append("60m MACD 金叉")

    score = max(0, min(100, int(score)))

    # 入场：优先回踩 MA5 / MA10
    entry = price
    entry_note = "现价附近介入"
    if ma5 and price > ma5 * 1.01:
        entry = round(ma5 * 0.995, 2)
        entry_note = f"回踩 MA5({ma5:.2f}) 接"
    elif ma10 and price > ma10 * 1.01:
        entry = round(ma10 * 0.995, 2)
        entry_note = f"回踩 MA10({ma10:.2f}) 接"

    # 动作判定
    if score >= 60 and len(hit) >= 4:
        action = "买入"
    elif score >= 45:
        action = "分批建仓"
    else:
        action = "观望"

    stop_loss = round(entry * 0.975, 2)
    tp = [round(entry * 1.03, 2), round(entry * 1.05, 2), round(entry * 1.08, 2)]

    risk = "单票≤15%仓位，单行业≤30%，同时持仓≤5只；账户回撤>8%暂停一周"
    reasons = (f"隔夜抢仓评分 {score}/100，命中 {len(hit)} 项。"
               f"建议「{action}」：回踩买点 {entry}（{entry_note}），"
               f"止损 {stop_loss}（-2.5%），三档止盈 {tp[0]}/{tp[1]}/{tp[2]}（+3/+5/+8%），持股 1-3 天。")

    return {
        "ok": True, "mode": "overnight", "code": code, "name": name,
        "price": price, "prev_close": prev_close,
        "score": score, "action": action,
        "entry": round(entry, 2), "entry_note": entry_note,
        "stop_loss": stop_loss, "take_profit": tp,
        "hold_days": "1-3天",
        "hit": hit, "miss": miss, "risk": risk, "reasons": reasons,
        "ind": {
            "ma5": ma5, "ma10": ma10, "ma20": ma20,
            "macd_hist": _last(hist), "kdj_j": jv, "rsi12": r,
            "roc5": round(roc5, 2), "vol_ratio": round(vol_ratio, 2),
        },
    }


# ---------------- 模式二 · 日内做 T ----------------
def intraday_t_signal(code, bars_1m, bars_5m=None, cost=None,
                      price=None, name="", prev_close=None, sim_time=None):
    """日内做 T 信号（底仓 T+0）。

    入参：
        code/name   : 股票代码/名称
        bars_1m     : 1 分钟 K线（≥30 根，主信号）
        bars_5m     : 5 分钟 K线（过滤趋势，可缺）
        cost        : 持仓成本（缺则 None，不计算成本差）
        price       : 实时价（缺则取 1m 末根）
    返回 dict（ok=True 时含 action/t_buy/t_sell/window/...）
    """
    if not bars_1m or len(bars_1m) < 30:
        return {"ok": False, "mode": "intraday",
                "msg": f"1分钟K线不足{len(bars_1m) if bars_1m else 0}根（需≥30）"}
    closes = [b["close"] for b in bars_1m if b.get("close") is not None]
    if len(closes) < 30:
        return {"ok": False, "mode": "intraday", "msg": "1分钟收盘价不足"}

    price = price if price else closes[-1]
    ind1 = compute_all(bars_1m)
    K1 = ind1["kdj"]["k"]
    D1 = ind1["kdj"]["d"]
    J1 = ind1["kdj"]["j"]
    up1 = ind1["boll"]["upper"]
    low1 = ind1["boll"]["lower"]
    dif1 = ind1["macd"]["dif"]
    dea1 = ind1["macd"]["dea"]
    vwap = _vwap(bars_1m)

    # 5m 过滤：趋势 + MACD
    trend_ok = True
    macd5_red = False
    if bars_5m and len(bars_5m) >= 20:
        i5 = compute_all(bars_5m)
        c5 = [b["close"] for b in bars_5m if b.get("close") is not None]
        m20_5 = _last(sma(c5, 20))
        if m20_5 and price < m20_5 * 0.98:
            trend_ok = False
        macd5_red = (_last(i5["macd"]["dif"]) is not None and _last(i5["macd"]["dea"]) is not None
                     and _last(i5["macd"]["dif"]) > _last(i5["macd"]["dea"]))

    vols1 = [b.get("volume") or 0 for b in bars_1m[-6:]]
    vol_pulse = _vol_ratio_recent(vols1, 5)

    jv = _last(J1)
    kv = _last(K1)
    dv = _last(D1)
    lu = _last(up1)
    ll = _last(low1)

    # 交易窗口（本地时间；回测可注入 sim_time=分钟数，避免用 datetime.now 失真）
    if sim_time is not None:
        hm = int(sim_time)
    else:
        now = datetime.datetime.now()
        hm = now.hour * 60 + now.minute
    if hm >= 14 * 60 + 50:
        window = "14:50 强制平仓窗口"
        force = True
    elif (9 * 60 + 30 <= hm <= 10 * 60) or (13 * 60 <= hm <= 13 * 60 + 30):
        window = "主交易窗口（早盘/午后活跃）"
        force = False
    else:
        window = "谨慎窗口（非早盘/午后活跃时段）"
        force = False

    hit = []
    miss = []
    buy_cond = []
    sell_cond = []

    if jv is not None and jv < 25:
        buy_cond.append("1m KDJ J 超卖")
        hit.append(f"KDJ J={jv:.0f} 超卖")
    if _cross_up(K1, D1, 2):
        buy_cond.append("1m KDJ 金叉")
        hit.append("1m KDJ 金叉")
    if vwap and price < vwap:
        buy_cond.append("价<VWAP")
        hit.append("价格低于 VWAP")
    if ll and price < ll * 1.01:
        buy_cond.append("贴 BOLL 下轨")
        hit.append("贴近 1m BOLL 下轨")
    if vol_pulse >= 2.0:
        hit.append(f"量能脉冲{vol_pulse:.1f}倍")

    if jv is not None and jv > 80:
        sell_cond.append("1m KDJ 超买")
        miss.append(f"KDJ J={jv:.0f} 超买")
    if _cross_down(K1, D1, 2):
        sell_cond.append("1m KDJ 死叉")
        miss.append("1m KDJ 死叉")
    if vwap and price > vwap:
        sell_cond.append("价>VWAP")
        miss.append("价格高于 VWAP")
    if lu and price > lu * 0.99:
        sell_cond.append("贴 BOLL 上轨")
        miss.append("贴近 1m BOLL 上轨")

    # 动作判定：低位接（价<VWAP 或 贴 BOLL 下轨）+ 不逆势（盘中共振过滤已含 5m 趋势）
    low_side = (vwap and price < vwap) or (ll and price < ll * 1.01)
    if force:
        action = "强制平仓"
        t_buy = None
        t_sell = round(price, 2)
    elif low_side and trend_ok:
        action = "做T买"
        t_buy = round((ll if ll and price > ll else price) * 0.998, 2)
        t_sell = round(price * 1.01, 2)
    elif len(sell_cond) >= 2 and (macd5_red or trend_ok):
        action = "做T卖"
        t_sell = round((lu if lu and price < lu else price) * 1.002, 2)
        t_buy = round(price * 0.99, 2)
    else:
        action = "持有不动"
        t_buy = None
        t_sell = None

    cost_diff_pct = round((price - cost) / cost * 100, 2) if cost else None
    target_pct = 1.0 if action in ("做T买", "做T卖") else None
    stop_pct = -1.0
    risk = "单次≤底仓30%，目标0.5-1.5%，-1%止损，当日≤2次，本月亏3%暂停"
    vwap_rel = ("价<VWAP" if (vwap and price < vwap) else "价>VWAP") if vwap else "无VWAP"
    reasons = (f"日内做T：当前动作「{action}」。成本差 {cost_diff_pct}%"
               f"，1m KDJ J={jv:.0f}，{vwap_rel}，量脉冲 {vol_pulse:.1f}倍。"
               f"{window}。")

    return {
        "ok": True, "mode": "intraday", "code": code, "name": name,
        "price": price, "cost": cost, "cost_diff_pct": cost_diff_pct,
        "action": action, "t_buy": t_buy, "t_sell": t_sell,
        "target_pct": target_pct, "stop_pct": stop_pct,
        "window": window, "force_close": "14:50",
        "max_times_per_day": 2,
        "vol_pulse": round(vol_pulse, 2), "vwap": round(vwap, 2) if vwap else None,
        "hit": hit, "miss": miss, "risk": risk, "reasons": reasons,
    }
