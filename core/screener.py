"""多因子选股模型（利益最大化导向）。

因子（合计 100%，动态因子主导，静态质量档仅做估值微调）：
  1. 技术面  30%  —— sig.analyze 综合技术分（趋势/动量/MACD/KDJ/BOLL）
  2. 行业轮动 28% —— 赛道实时强度(腾讯实时涨跌幅均值) + 赛道20日动量(成分股)
  3. 估值/基本面 27% —— 腾讯实时 PE 曲线 + 质量档(grade) 微调
  4. 个股动量 15% —— 近20日涨幅，捕捉主升浪/突破
  （行业新闻 best-effort，云端 Render 通；本地降级为中性，不计入权重）

数据来源（全部本地可达，无需东财）：
  - 技术/动量/K线：新浪日K线 (ds.get_kline)
  - 行业轮动/PE/市值：腾讯实时行情 (ds.fetch_realtime)
  - 新闻：东财快讯 (nw)，云端可达，本地静默降级

设计目标：让扫描排名随「板块轮动 + 价格动量 + 估值变化 + 新闻催化」每日动态变化，
而不是被写死的 quality grade 锁死。
"""

import threading

# 权重（合计 1.0）
W_TECH = 0.30
W_SECTOR = 0.28
W_VAL = 0.27
W_MOM = 0.15

GRADE_BASE = {"A": 82.0, "B": 68.0, "C": 50.0}


def clamp(v, lo=0.0, hi=100.0):
    return max(lo, min(hi, v))


def valuation_score(pe, grade):
    """估值/基本面分 0-100：PE 曲线(主) + 质量档(微调)。

    - PE 低(<=15) 深度价值加分；15~30 合理加分；30~50 中性；50~80 偏贵减分；>80 高估减分；亏损减分。
    - grade 作为稳定器：A/B/C 给基础分偏移。
    """
    base = GRADE_BASE.get(grade, 68.0)
    if pe is not None:
        try:
            pe = float(pe)
            if pe <= 0:
                base -= 12.0          # 亏损
            elif pe <= 15:
                base += 12.0         # 深度价值
            elif pe <= 30:
                base += 8.0          # 合理偏低
            elif pe <= 50:
                base += 2.0          # 合理
            elif pe <= 80:
                base -= 6.0          # 偏贵
            else:
                base -= 14.0         # 高估
        except (TypeError, ValueError):
            pass
    return clamp(base)


def momentum20(bars):
    """近20日动量分 0-100：20日收益率映射到 50±区间。

    返回 (mom_score, ret_pct)。ret_pct = (现价/20日前收盘 - 1)*100。
    """
    try:
        if len(bars) < 22:
            return 50.0, 0.0
        price = float(bars[-1]["close"])
        prev = float(bars[-21]["close"])
        if prev <= 0:
            return 50.0, 0.0
        ret = (price / prev - 1) * 100.0
        score = clamp(50.0 + ret * 3.0)   # 涨20%→+60分；跌20%→-60分
        return score, round(ret, 2)
    except Exception:
        return 50.0, 0.0


def _median(xs):
    xs = [x for x in xs if x is not None]
    if not xs:
        return None
    xs = sorted(xs)
    n = len(xs)
    if n % 2 == 1:
        return xs[n // 2]
    return (xs[n // 2 - 1] + xs[n // 2]) / 2.0


def apply_sector_momentum(results):
    """扫描后处理：用同赛道成分股的20日动量中位数，给行业轮动分叠加「赛道动量」维度。

    让行业分既反映今日强弱，也反映中期趋势，避免只看一日涨跌造成排名抖动或僵化。
    """
    by_track = {}
    for r in results:
        by_track.setdefault(r.get("track"), []).append(r)
    for track, rs in by_track.items():
        moms = [r.get("_mom_ret") for r in rs if r.get("_mom_ret") is not None]
        med = _median(moms)
        if med is None:
            continue
        sec_mom_score = clamp(50.0 + med * 2.5)
        for r in rs:
            r["sector_mom"] = round(med, 2)
            new_sec = r.get("sector_score", 50.0) * 0.6 + sec_mom_score * 0.4
            r["sector_score"] = round(new_sec, 1)
            # 重算综合分（动态因子主导）
            tech = r.get("tech_score", 0.0) or 0.0
            val = r.get("val_score", 0.0) or 0.0
            mom = r.get("mom_score", 50.0) or 50.0
            r["combined"] = round(
                tech * W_TECH + new_sec * W_SECTOR + val * W_VAL + mom * W_MOM, 1)


def action_for(combined, mom_ret, tech):
    """根据综合分 + 动量 + 技术，给出利益最大化导向的操作建议。"""
    if combined >= 72 and (mom_ret or 0) > 0 and tech >= 55:
        return "强烈买入"
    if combined >= 62:
        return "买入"
    if combined >= 52:
        return "持有"
    return "观望"


def compute_factors(code, bars, realtime, fund_meta, sector_strength):
    """单只股票因子计算，返回 dict（含各因子分 + 临时字段）。

    realtime: ds.fetch_realtime 单只结果（含 pe / change_pct / market_cap）
    fund_meta: ip.get_fund(code) 结果（含 grade / track / sector / note）
    sector_strength: sf.sector_strength(track) 结果（含 score / trend_pct / fund_net / up_ratio）
    """
    fp = fund_meta or {}
    track = fp.get("track")
    sector = fp.get("sector")
    grade = fp.get("grade", "B")
    note = fp.get("note", "")

    tech = 50.0
    # 技术分由调用方用 sig.analyze 结果填入（保持与现有信号体系一致）
    # 这里只算估值/动量/行业

    pe = None
    if isinstance(realtime, dict):
        pe = realtime.get("pe")
    val = valuation_score(pe, grade)
    mom_score, mom_ret = momentum20(bars)

    ss = sector_strength or {}
    sector_score = ss.get("score", 50.0)
    sector_trend = ss.get("trend_pct")
    sector_fund = ss.get("fund_net")
    up_ratio = ss.get("up_ratio")

    return {
        "pe": pe,
        "val_score": round(val, 1),
        "mom_score": round(mom_score, 1),
        "_mom_ret": mom_ret,
        "track": track,
        "sector": sector,
        "fund_grade": grade,
        "note": note,
        "sector_score": round(sector_score, 1),
        "sector_trend": sector_trend,
        "sector_fund": sector_fund,
        "up_ratio": up_ratio,
    }
