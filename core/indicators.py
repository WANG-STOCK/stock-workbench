"""技术指标引擎：MA / EMA / MACD / KDJ / RSI / BOLL（纯 Python，无第三方依赖）。

每个函数接受与 K 线对齐的价格序列，返回与输入等长、前置为 None 的序列。
"""


def sma(values, n):
    out = [None] * len(values)
    if n <= 0 or len(values) < n:
        return out
    s = 0.0
    for i, v in enumerate(values):
        s += v
        if i >= n:
            s -= values[i - n]
        if i >= n - 1:
            out[i] = s / n
    return out


def ema(values, n):
    """EMA，前 n 个有效值用 SMA 播种，其余为 None。"""
    out = [None] * len(values)
    if n <= 0 or len(values) < n:
        return out
    k = 2.0 / (n + 1)
    seed = sum(values[:n]) / n
    out[n - 1] = seed
    prev = seed
    for i in range(n, len(values)):
        prev = values[i] * k + prev * (1 - k)
        out[i] = prev
    return out


def macd(closes, fast=12, slow=26, signal=9):
    ef = ema(closes, fast)
    es = ema(closes, slow)
    dif = [(ef[i] - es[i]) if (ef[i] is not None and es[i] is not None) else None
           for i in range(len(closes))]
    start = next((i for i, v in enumerate(dif) if v is not None), None)
    dea = [None] * len(dif)
    if start is not None:
        sub = dif[start:]
        dea_sub = ema(sub, signal)
        for j, v in enumerate(dea_sub):
            dea[start + j] = v
    hist = [(dif[i] - dea[i]) * 2 if (dif[i] is not None and dea[i] is not None) else None
            for i in range(len(dif))]
    return dif, dea, hist


def kdj(highs, lows, closes, n=9, m1=3, m2=3):
    size = len(closes)
    K = [None] * size
    D = [None] * size
    J = [None] * size
    prevK = 50.0
    prevD = 50.0
    for i in range(size):
        if i < n - 1:
            K[i] = prevK
            D[i] = prevD
            J[i] = 3 * prevK - 2 * prevD
            continue
        wh = max(highs[i - n + 1:i + 1])
        wl = min(lows[i - n + 1:i + 1])
        rsv = 50.0 if wh == wl else (closes[i] - wl) / (wh - wl) * 100.0
        k = prevK * (m1 - 1) / m1 + rsv / m1
        d = prevD * (m2 - 1) / m2 + k / m2
        j = 3 * k - 2 * d
        K[i], D[i], J[i] = k, d, j
        prevK, prevD = k, d
    return K, D, J


def rsi(closes, n=14):
    size = len(closes)
    out = [None] * size
    gains = 0.0
    losses = 0.0
    for i in range(1, size):
        ch = closes[i] - closes[i - 1]
        g = ch if ch > 0 else 0.0
        l = -ch if ch < 0 else 0.0
        if i <= n:
            gains += g
            losses += l
            if i == n:
                out[i] = 100.0 if losses == 0 else 100 - 100 / (1 + (gains / n) / (losses / n))
        else:
            gains = (gains * (n - 1) + g) / n
            losses = (losses * (n - 1) + l) / n
            out[i] = 100.0 if losses == 0 else 100 - 100 / (1 + gains / losses)
    return out


def boll(closes, n=20, k=2):
    mid = sma(closes, n)
    upper = [None] * len(closes)
    lower = [None] * len(closes)
    for i in range(len(closes)):
        if mid[i] is None:
            continue
        window = closes[i - n + 1:i + 1]
        mean = mid[i]
        var = sum((x - mean) ** 2 for x in window) / n
        sd = var ** 0.5
        upper[i] = mean + k * sd
        lower[i] = mean - k * sd
    return mid, upper, lower


def compute_all(bars):
    """对一组 K 线（dict: date/open/high/low/close/volume）计算全部指标。"""
    closes = [b["close"] for b in bars]
    highs = [b["high"] for b in bars]
    lows = [b["low"] for b in bars]
    vols = [b["volume"] for b in bars]

    ma5 = sma(closes, 5)
    ma10 = sma(closes, 10)
    ma20 = sma(closes, 20)
    ma60 = sma(closes, 60)
    ma120 = sma(closes, 120)
    ma250 = sma(closes, 250)

    dif, dea, hist = macd(closes)
    K, D, J = kdj(highs, lows, closes)
    rsi6 = rsi(closes, 6)
    rsi12 = rsi(closes, 12)
    rsi24 = rsi(closes, 24)
    boll_mid, boll_up, boll_low = boll(closes)

    vol_ma5 = sma(vols, 5)

    return {
        "ma5": ma5, "ma10": ma10, "ma20": ma20,
        "ma60": ma60, "ma120": ma120, "ma250": ma250,
        "macd": {"dif": dif, "dea": dea, "hist": hist},
        "kdj": {"k": K, "d": D, "j": J},
        "rsi": {"rsi6": rsi6, "rsi12": rsi12, "rsi24": rsi24},
        "boll": {"mid": boll_mid, "upper": boll_up, "lower": boll_low},
        "vol_ma5": vol_ma5,
    }
