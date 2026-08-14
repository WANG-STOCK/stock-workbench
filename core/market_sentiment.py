"""大盘全局情绪数据（超短线四维决策之四）。

抓取：上证指数 / 创业板指 / 沪深300 的实时涨跌与主净资金，
全 A 涨跌家数（涨/跌/平）、涨停/跌停家数、两市成交额（亿元），
综合给出「情绪标签 + 风险等级 + 风险提示」，供 AI 决策面板做大环境过滤。

依赖：core.data_source._http_get（东财 push2 接口，沙箱实测可用）。
所有请求带缓存（默认 20s），避免高频刷新打爆接口。
"""
import time
import json

from core import data_source as ds

_CACHE = {"ts": 0, "data": None}
_TTL = 20  # 秒


def _f(v):
    """东财字段常为字符串或 '-'，统一转 float，失败返回 None。"""
    if v is None or v == "-":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _em(url, referer="https://quote.eastmoney.com/"):
    try:
        raw = ds._http_get(url, referer=referer, timeout=10)
        return json.loads(raw) if raw else None
    except Exception:
        return None


def _index_quotes():
    """上证指数 / 创业板指 / 沪深300：现价、涨跌幅、振幅、换手率（fetch_realtime 稳定源）。"""
    codes = ["sh000001", "sz399006", "sh000300"]
    try:
        rt = ds.fetch_realtime(codes) or {}
    except Exception:
        return {}
    names = {"sh000001": "上证指数", "sz399006": "创业板指", "sh000300": "沪深300"}
    out = {}
    for c in codes:
        q = rt.get(c) or {}
        if not q.get("price"):
            continue
        out[c[2:]] = {  # key 取 000001 / 399006 / 000300
            "name": names.get(c, q.get("name")),
            "price": q.get("price"),
            "change_pct": q.get("change_pct"),
            "amplitude": q.get("amplitude"),
            "turnover_pct": q.get("turnover"),
        }
    return out


def _market_amount_yi():
    """两市成交额（亿元）：上证 + 深证成指 成交额之和。best-effort，失败返回 None。"""
    total = 0.0
    ok = False
    for secid in ("1.000001", "0.399001"):
        try:
            url = ("https://push2.eastmoney.com/api/qt/stock/get?secid=" + secid
                   + "&fields=f6&invt=2&fltt=2" + f"&_={int(time.time()*1000)}")
            d = _em(url)
            v = (d or {}).get("data", {}).get("f6")
            if v:
                total += _f(v) / 1e8
                ok = True
        except Exception:
            continue
    return round(total, 0) if ok else None


def _breadth():
    """全 A 涨跌家数 + 涨停/跌停家数。

    用 clist 拉全市场（沪 m:1 + 深 m:0），统计 f3(涨跌幅)。
    pz 取大但带异常兜底：失败返回 None，由调用方降级到"仅指数"情绪。
    """
    url = ("https://push2.eastmoney.com/api/qt/clist/get"
           "?pn=1&pz=8000&po=1&np=1&fltt=2&invt=2"
           "&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23"
           "&fields=f3,f12")
    d = _em(url)
    rows = (d or {}).get("data", {}).get("diff") or []
    if not rows:
        return None
    up = sum(1 for r in rows if (_f(r.get("f3")) or 0) > 0)
    down = sum(1 for r in rows if (_f(r.get("f3")) or 0) < 0)
    flat = len(rows) - up - down
    zt = sum(1 for r in rows if (_f(r.get("f3")) or 0) >= 9.8)
    dt = sum(1 for r in rows if (_f(r.get("f3")) or 0) <= -9.8)
    return {"total": len(rows), "up": up, "down": down, "flat": flat,
            "limit_up": zt, "limit_down": dt}


def get_market_sentiment(force=False):
    """返回大盘全局情绪 dict。带缓存。"""
    now = time.time()
    if not force and _CACHE["data"] and now - _CACHE["ts"] < _TTL:
        return _CACHE["data"]

    idx = _index_quotes()
    br = _breadth()
    amt = _market_amount_yi()

    sh = idx.get("000001") or {}
    cyb = idx.get("399006") or {}
    hs300 = idx.get("000300") or {}

    sh_pct = sh.get("change_pct")
    cyb_pct = cyb.get("change_pct")

    # 涨跌家数比
    breadth_ratio = None
    up = down = None
    if br:
        up, down = br["up"], br["down"]
        if (up + down) > 0:
            breadth_ratio = up / (up + down)

    # ---- 综合情绪评分（0~100，越大越乐观）----
    score = 50.0
    if sh_pct is not None:
        score += min(max(sh_pct, -3), 3) * 8      # 上证 ±3% → ±24 分
    if cyb_pct is not None:
        score += min(max(cyb_pct, -3), 3) * 4      # 创业板弹性更高
    if breadth_ratio is not None:
        score += (breadth_ratio - 0.5) * 40        # 家数比 0.5→0 分，1.0→+20，0.0→-20
    score = max(0, min(100, round(score)))

    # ---- 情绪标签 ----
    label, level, tip = _classify(score, sh_pct, breadth_ratio, br)

    # ---- 风险等级（给开仓仓位用）----
    risk_level = "低" if score >= 65 else ("中" if score >= 45 else "高")
    if score < 45:
        risk_tip = "大盘偏弱、涨跌家数劣势，建议降低开仓仓位、减少做T频率、严控止损"
    elif score >= 65:
        risk_tip = "市场情绪偏暖、涨跌家数占优，可积极但勿追高，严守止盈止损"
    else:
        risk_tip = "市场中性震荡，按需操作，单票不超仓位上限"

    data = {
        "ok": True,
        "ts": _now_str(),
        "indices": {
            "sh": {"name": "上证指数", "price": sh.get("price"), "change_pct": sh_pct,
                   "amplitude": sh.get("amplitude"), "turnover_pct": sh.get("turnover_pct")},
            "cyb": {"name": "创业板指", "price": cyb.get("price"), "change_pct": cyb_pct,
                    "amplitude": cyb.get("amplitude"), "turnover_pct": cyb.get("turnover_pct")},
            "hs300": {"name": "沪深300", "price": hs300.get("price"),
                      "change_pct": hs300.get("change_pct"),
                      "amplitude": hs300.get("amplitude"), "turnover_pct": hs300.get("turnover_pct")},
        },
        "turnover_yi": amt,
        "breadth": {"up": up, "down": down, "flat": (br or {}).get("flat"),
                    "limit_up": (br or {}).get("limit_up"),
                    "limit_down": (br or {}).get("limit_down"),
                    "ratio": round(breadth_ratio, 3) if breadth_ratio is not None else None},
        "sentiment_score": score,
        "sentiment_label": label,
        "sentiment_level": level,
        "risk_level": risk_level,
        "risk_tip": risk_tip,
        "tip": tip,
        "source": "eastmoney push2" + ("+breadth" if br else " (breadth 缺失，仅指数)"),
    }
    _CACHE["ts"] = now
    _CACHE["data"] = data
    return data


def _classify(score, sh_pct, ratio, br):
    if score >= 75:
        return "强势多头", "强", "市场放量普涨，主线清晰，可积极做多/做T"
    if score >= 60:
        return "偏多", "偏强", "多数个股上涨，可择强开仓/做T"
    if score >= 45:
        return "震荡中性", "中性", "涨跌参半，按信号操作、不追高"
    if score >= 30:
        return "偏弱", "偏弱", "赚钱效应差，降低仓位、减少频率"
    return "恐慌避险", "弱", "普跌格局，暂停开仓、仅做持仓日内T降成本"


def _now_str():
    return time.strftime("%Y-%m-%d %H:%M:%S")


if __name__ == "__main__":
    print(json.dumps(get_market_sentiment(force=True), ensure_ascii=False, indent=2))
