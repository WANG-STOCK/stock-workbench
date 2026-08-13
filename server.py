"""股票工作台后端：零依赖 HTTP 服务 + 行情/信号/选股/预警 API。

运行：python server.py  （默认 http://127.0.0.1:8723）
"""

import os
import sys
import json
import time
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from core import data_source as ds
from core import signals as sig
from core.indicators import compute_all
from core import industry_pool as ip
from core import fundamentals as fm
from core import sector_flow as sf
from core import news as nw
from core import screener as sc
from core import intraday as intraday_mod
from core import daily_strategy as dsmod
from core.daily_strategy import run_daily, open_judgment, generate_snapshot, generate_review

BASE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE, "data")
WATCHLIST = os.path.join(DATA_DIR, "watchlist.json")
# 云端/本地共用的自选主源（git 跟踪，部署/重启不丢，作为 data 兜底）
STATIC_WATCHLIST = os.path.join(BASE, "static", "watchlist.json")
ALERTS = os.path.join(DATA_DIR, "alerts.json")
REVIEW = os.path.join(DATA_DIR, "review.json")
POSITIONS = os.path.join(DATA_DIR, "positions.json")
# 云端/本地共用的持仓主源（git 跟踪，公开 URL 可达，部署/重启不丢）
STATIC_POSITIONS = os.path.join(BASE, "static", "positions.json")
# 账户数据（现金 + 当日基准快照，用于"真实当日盈亏"计算）：runtime 双写 static 主源
ACCOUNT = os.path.join(DATA_DIR, "account.json")
STATIC_ACCOUNT = os.path.join(BASE, "static", "account.json")
CONFIG = os.path.join(DATA_DIR, "config.json")

os.makedirs(DATA_DIR, exist_ok=True)

# ---------- 配置 ----------
_config = {"tdx_path": "", "kline_ttl": {"5m": 30, "15m": 60, "30m": 120, "60m": 300,
                                         "daily": 300, "weekly": 600},
          "weights": {}, "position": {"capital": 100000, "max_single": 0.25, "lot": 100},
          "monitor": {"scope": "watchlist", "strategy": "composite", "top_n": 10},
          "available_capital": 100000}
if os.path.isfile(CONFIG):
    try:
        _config.update(json.load(open(CONFIG, encoding="utf-8")))
    except Exception:
        pass

_WEIGHT_MULT = _config.get("weight_multipliers") or {}
_WEIGHTS = sig.expand_weights(_WEIGHT_MULT)
_POS = _config.get("position") or {"capital": 100000, "max_single": 0.25, "lot": 100}
_MON = _config.get("monitor") or {"scope": "watchlist", "strategy": "composite", "top_n": 10}
_CLOUD_URL = _config.get("cloud_url", "") or ""

_tdx_path = _config.get("tdx_path", "")
_tdx_available = bool(_tdx_path) and os.path.isdir(_tdx_path)

# 全 A 股代码池（在线自动生成，无需通达信）
_universe_cache = None
_universe_lock = threading.Lock()

# 后台扫描任务状态
_scan = {"running": False, "total": 0, "done": 0, "results": [], "started": 0.0,
         "error": None, "scope": "", "strategy": ""}

# ---------- K线缓存 ----------
_kline_cache = {}
_kline_lock = threading.Lock()


def _cache_get(code, period, limit):
    key = (code, period, limit)
    with _klock_guard():
        if key in _kline_cache:
            ts, bars = _kline_cache[key]
            ttl = _config["kline_ttl"].get(period, 120)
            if time.time() - ts < ttl:
                return bars
    return None


def _cache_set(code, period, limit, bars):
    key = (code, period, limit)
    with _klock_guard():
        _kline_cache[key] = (time.time(), bars)


def _klock_guard():
    return _kline_lock


# ---------- 持久化 ----------
def _load_json(path, default):
    if not os.path.isfile(path):
        return default
    try:
        return json.load(open(path, encoding="utf-8"))
    except Exception:
        return default


def _save_json(path, obj):
    json.dump(obj, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)


# ---------- 账户数据：现金 + 当日基准快照（用来算"真实当日盈亏"） ----------
def _load_account():
    """返回标准化账户：{cash, baseline_date, baseline_cash, baseline_shares{code:shares}}。
    读取优先级：data/account.json（runtime）> static/account.json（git 主源兜底）。"""
    a = _load_json(ACCOUNT, None)
    if not isinstance(a, dict):
        a = _load_json(STATIC_ACCOUNT, None)
    if not isinstance(a, dict):
        a = {}
    a.setdefault("cash", 0)
    a.setdefault("baseline_date", "")
    a.setdefault("baseline_cash", 0)
    a.setdefault("baseline_shares", {})
    return a


def _sync_account(a):
    """双写 runtime + 主源（云端只读时跳过主源）。"""
    _save_json(ACCOUNT, a)
    try:
        _save_json(STATIC_ACCOUNT, a)
    except Exception as e:
        print("[WARN] static account write failed (cloud may be read-only):", e)


# ---------- 选股：按范围取代码 ----------
def _get_universe():
    """返回全 A 股代码池；首次调用时在线生成并校验，结果写入 universe.txt 缓存。"""
    global _universe_cache
    with _universe_lock:
        if _universe_cache is not None:
            return _universe_cache
        u = os.path.join(DATA_DIR, "universe.txt")
        codes = [l.strip() for l in open(u, encoding="utf-8")
                 if l.strip() and not l.startswith("#")] if os.path.isfile(u) else []
        if not codes:
            try:
                codes = ds.refresh_universe(u)
            except Exception:
                codes = []
        _universe_cache = codes
        return codes


def _scope_codes(scope):
    if scope == "watchlist":
        return [w["code"] for w in _load_watchlist()]
    if scope == "candidate":
        return ip.pool_codes()
    if scope == "universe":
        u = os.path.join(DATA_DIR, "universe.txt")
        if not os.path.isfile(u):
            return []
        return [l.strip() for l in open(u, encoding="utf-8") if l.strip() and not l.startswith("#")]
    if scope == "tdx":
        if not _tdx_available:
            return []
        return ds.list_tdx_codes(_tdx_path)
    if scope == "online_all":
        return _get_universe()
    return []


# ---------- 自选股：支持带元数据的对象（添加时间/价格/推荐买价） ----------
def _load_watchlist():
    """返回标准化自选列表：[{code, name, add_time, add_price, scan_buy}, ...]。
    兼容旧版纯字符串列表。
    读取优先级：data/watchlist.json（runtime）> static/watchlist.json（git 主源兜底）。
    注意：data 文件若已存在（即使是空数组）也优先用 data —— 空数组代表用户主动清空，
    不能回退到主源覆盖用户的"已清空"意图。"""
    raw = _load_json(WATCHLIST, None)
    if raw is None:
        raw = _load_json(STATIC_WATCHLIST, [])
    out = []
    for e in (raw or []):
        if isinstance(e, str):
            out.append({"code": e, "name": "", "add_time": None,
                        "add_price": None, "scan_buy": None})
        elif isinstance(e, dict) and e.get("code"):
            out.append({"code": e["code"], "name": e.get("name", ""),
                        "add_time": e.get("add_time"), "add_price": e.get("add_price"),
                        "scan_buy": e.get("scan_buy")})
    return out


def _sync_watchlist(items):
    """双写：runtime（data/）+ 主源（static/，git 跟踪，云端部署同步）。
    云端只读时跳过主源写入，本地写依然成功。"""
    _save_json(WATCHLIST, items)
    try:
        _save_json(STATIC_WATCHLIST, items)
    except Exception as e:
        print("[WARN] static watchlist write failed (cloud may be read-only):", e)


# ---------- 个股基本面/预期事实缓存（PE + 机构目标价 + 新闻，best-effort） ----------
_FACTS_CACHE = {}
_FACTS_LOCK = threading.Lock()


def _stock_facts(code, ttl=300):
    """返回 {pe, pb, target, target_upside, news_score}；任何缺失均 None。带 5 分钟缓存。"""
    now = time.time()
    with _FACTS_LOCK:
        c = _FACTS_CACHE.get(code)
        if c and now - c[0] < ttl:
            return c[1]
    try:
        val = fm.batch_valuation([code]) or {}
        v = val.get(code) or {}
        pe = v.get("pe")
        target = fm.fetch_target_price(code)
        price = None
        try:
            rt = ds.fetch_realtime([code]) or {}
            price = (rt.get(code) or {}).get("price")
        except Exception:
            price = None
        target_upside = round(target / price - 1, 4) if (target and price) else None
        news_score = 0
        try:
            nw_d = nw.stock_news(code)
            if nw_d.get("status") == "ok":
                news_score = nw.news_sentiment(nw_d["headlines"])
        except Exception:
            news_score = 0
        facts = {"pe": pe, "pb": v.get("pb"), "target": target,
                 "target_upside": target_upside, "news_score": news_score}
    except Exception:
        facts = {"pe": None, "pb": None, "target": None,
                 "target_upside": None, "news_score": 0}
    with _FACTS_LOCK:
        _FACTS_CACHE[code] = (now, facts)
    return facts


# ---------- 每日复盘：按日期记录开盘建议/最高/收盘，复盘准确率 ----------
def _load_review():
    return _load_json(REVIEW, {})


def _today_str():
    return time.strftime("%Y-%m-%d")


def _capture_review(rec):
    """前端每轮刷新上报快照；后端合并到「今天」记录。
    rec: {code, name, price, high, low, action, op_price, op_qty}
    - 首次出现填开盘建议；始终更新 high/low/最新；收盘后(>=15:00)填收盘。
    """
    date = _today_str()
    store = _load_review()
    day = store.setdefault(date, {})
    code = rec.get("code")
    if not code:
        return store
    r = day.get(code) or {}
    if "open_action" not in r:
        r["open_action"] = rec.get("action")
        r["open_price"] = rec.get("price")
        r["open_op_price"] = rec.get("op_price")
        r["open_op_qty"] = rec.get("op_qty")
        r["name"] = rec.get("name") or r.get("name")
    r["name"] = rec.get("name") or r.get("name")
    r["high"] = max(r.get("high") if r.get("high") is not None else -1e9,
                    rec.get("high") if rec.get("high") is not None else -1e9)
    r["low"] = min(r.get("low") if r.get("low") is not None else 1e9,
                   rec.get("low") if rec.get("low") is not None else 1e9)
    r["last_action"] = rec.get("action")
    r["last_price"] = rec.get("price")
    r["last_op_price"] = rec.get("op_price")
    # 收盘判定：本地时间 >= 15:00（A股已收盘）
    hour = time.localtime().tm_hour
    if hour >= 15:
        r["close_action"] = rec.get("action")
        r["close_price"] = rec.get("price")
        r["close_op_price"] = rec.get("op_price")
    day[code] = r
    store[date] = day
    _save_json(REVIEW, store)
    return store


def _review_summary(date=None):
    """汇总某日复盘：是否做对 + 按建议做T盈亏估算。"""
    store = _load_review()
    date = date or _today_str()
    day = store.get(date, {})
    out = []
    for code, r in day.items():
        oa = r.get("open_action")
        oprice = r.get("open_op_price")
        oqty = r.get("open_op_qty") or 0
        close_p = r.get("close_price") or r.get("last_price")
        high = r.get("high")
        correct = None
        pnl = None
        if oa == "买入" and oprice and close_p:
            pnl = round((close_p - oprice) * oqty, 2)
            correct = close_p > oprice
        elif oa == "卖出" and oprice and close_p:
            pnl = round((oprice - close_p) * oqty, 2)
            correct = close_p < oprice
        out.append({
            "code": code, "name": r.get("name", ""),
            "open_action": oa, "open_op_price": oprice,
            "high": high, "low": r.get("low"),
            "close_price": close_p, "close_action": r.get("close_action"),
            "correct": correct, "pnl": pnl,
        })
    # 按是否做对 + 盈亏排序
    out.sort(key=lambda x: (x["correct"] is not True, -(x["pnl"] or 0)))
    return {"date": date, "count": len(out), "rows": out}


def _action_sort_key(r):
    """排序键：动作优先级（强买>买入>持有>减仓>卖出）优先，其次综合分/评分降序。"""
    act = sig.ACTION_RANK.get(r.get("action"), 0)
    sc = r.get("combined") if r.get("combined") is not None else r.get("score", 0)
    return (-act, -(sc or 0))


def _chunk(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def _load_positions():
    # 1. 本地运行时覆盖（POST 写入，git 排除）：优先用
    p = _load_json(POSITIONS, None)
    if p is not None:
        return p
    # 2. 云端/本地共用主源（git 跟踪）：云端部署后自动同步，重启不丢
    return _load_json(STATIC_POSITIONS, [])


def _held_shares(code):
    for p in _load_positions():
        if p.get("code") == code:
            try:
                return int(p.get("shares", 0) or 0)
            except (TypeError, ValueError):
                return 0
    return 0


def _build_position(analysis, qs, code=None):
    """根据查询参数（可覆盖 config）生成仓位建议；未显式给持仓时自动取持仓台账。"""
    try:
        capital = float(qs.get("capital", [None])[0] or _POS.get("capital", 100000))
    except (TypeError, ValueError):
        capital = _POS.get("capital", 100000)
    try:
        max_single = float(qs.get("max_single", [None])[0] or _POS.get("max_single", 0.25))
    except (TypeError, ValueError):
        max_single = _POS.get("max_single", 0.25)
    if "current_shares" in qs:
        try:
            current_shares = int(qs.get("current_shares", [None])[0] or 0)
        except (TypeError, ValueError):
            current_shares = 0
    else:
        current_shares = _held_shares(code) if code else 0
    price = analysis.get("price") or 0
    pos = sig.position_advice(analysis["score"], analysis["action"], price,
                              capital=capital, max_single=max_single,
                              current_shares=current_shares, lot=_POS.get("lot", 100))
    # 附带技术面建议买卖价（基于支撑/阻力），供持仓面板展示
    pl = analysis.get("price_levels") or {}
    pos["buy_price"] = pl.get("buy")
    pos["sell_price"] = pl.get("sell")
    pos["support"] = pl.get("support")
    pos["resist"] = pl.get("resist")
    return pos


def _build_forecast(a, regime, outlook, prev_close, action):
    """今日预估：综合开盘价/集合竞价/板块涨跌/资金净流/均线方向，给出 (trend, pct, basis[])。"""
    ind = (a or {}).get("indicators") or {}
    macd = ind.get("macd") or {}
    kdj = ind.get("kdj") or {}
    ma = ind.get("ma") or {}   # ma 是 dict: {ma5, ma10, ma20, ma60}
    ma5 = ma.get("ma5")
    ma10 = ma.get("ma10")
    ma20 = ma.get("ma20")
    # MACD/KDJ 在 indicators 模块里就是标量（末值）
    dif = macd.get("dif")
    dea = macd.get("dea")
    hist = macd.get("hist")
    k_v = kdj.get("k")
    d_v = kdj.get("d")
    price = (a or {}).get("price")
    op = (a or {}).get("open")
    basis = []
    pct = 0.0
    # 1) 开盘跳空（集合竞价）
    if op and prev_close:
        gap = (op - prev_close) / prev_close * 100
        if gap >= 0.5:
            basis.append(f"高开 +{gap:.1f}%（集合竞价偏多）")
            pct += 0.5
        elif gap <= -0.5:
            basis.append(f"低开 {gap:.1f}%（集合竞价偏空）")
            pct -= 0.5
    # 2) 板块资金流
    if regime:
        tpct = regime.get("trend_pct")
        fn = regime.get("fund_net")
        if tpct is not None:
            if tpct >= 1.5:
                basis.append(f"所属板块 +{tpct:.1f}% 强势")
                pct += tpct * 0.4
            elif tpct <= -1.5:
                basis.append(f"所属板块 {tpct:.1f}% 弱势")
                pct += tpct * 0.4  # 已是负
        if fn is not None:
            if fn >= 2:
                basis.append(f"资金净流入 +{fn:.1f}亿")
                pct += 0.8
            elif fn <= -2:
                basis.append(f"资金净流出 {fn:.1f}亿")
                pct -= 0.8
    # 3) 均线趋势（多头/空头/震荡）
    if ma5 and ma10 and ma20 and price:
        if price > ma5 > ma10 > ma20:
            basis.append("价>MA5>MA10>MA20 多头排列")
            pct += 1.2
        elif price < ma5 < ma10 < ma20:
            basis.append("价<MA5<MA10<MA20 空头排列")
            pct -= 1.2
        elif price > ma20 and ma5 > ma10:
            basis.append("价站上MA20、MA5>MA10 偏多")
            pct += 0.6
        elif price < ma20 and ma5 < ma10:
            basis.append("价跌破MA20、MA5<MA10 偏空")
            pct -= 0.6
        else:
            basis.append("均线交织 震荡")
    # 4) MACD 方向
    if dif is not None and dea is not None:
        if dif > dea and (hist is not None and hist > 0):
            basis.append("MACD 金叉 红柱")
            pct += 0.5
        elif dif < dea and (hist is not None and hist < 0):
            basis.append("MACD 死叉 绿柱")
            pct -= 0.5
    # 5) KDJ 状态
    if k_v is not None and d_v is not None:
        if k_v > 80 and d_v > 80:
            basis.append(f"KDJ({k_v:.0f},{d_v:.0f}) 超买")
            pct -= 0.4
        elif k_v < 20 and d_v < 20:
            basis.append(f"KDJ({k_v:.0f},{d_v:.0f}) 超卖")
            pct += 0.4
    # 定性：把 pct 映射到 trend
    if pct >= 0.8:
        trend = "偏多"
    elif pct <= -0.8:
        trend = "偏空"
    else:
        trend = "震荡"
    if outlook and outlook.get("trend"):
        trend = outlook["trend"]   # 以 sig.day_outlook 的定性为准（已综合技术+资金）
    return {
        "trend": trend,
        "pct": round(pct, 2),
        "basis": basis[:6],         # 最多 6 条
    }


def _build_sector_detail(regime):
    """板块详情：把 strength 结果翻译成中文展示。"""
    if not regime:
        return None
    name = regime.get("track") or regime.get("sector") or "—"
    tpct = regime.get("trend_pct")
    fn = regime.get("fund_net")
    up_ratio = regime.get("up_ratio")
    state = "强"
    if tpct is not None and tpct < 0:
        state = "弱"
    elif tpct is not None and tpct > 0:
        state = "强"
    return {
        "name": name,
        "track": regime.get("track"),
        "sector": regime.get("sector"),
        "trend_pct": tpct,
        "fund_net": fn,
        "fund_proxy": regime.get("fund_proxy", False),
        "up_ratio": up_ratio,
        "state": state,
    }


def _build_technical(a, tl, pl, price):
    """技术面：MA + MACD/KDJ/BOLL 状态 + 关键支撑压力位。"""
    ind = (a or {}).get("indicators") or {}
    macd = ind.get("macd") or {}
    kdj = ind.get("kdj") or {}
    boll = ind.get("boll") or {}
    ma = ind.get("ma") or {}
    ma5 = ma.get("ma5")
    ma10 = ma.get("ma10")
    ma20 = ma.get("ma20")
    dif = macd.get("dif")
    dea = macd.get("dea")
    hist = macd.get("hist")
    k_v = kdj.get("k")
    d_v = kdj.get("d")
    boll_upper = boll.get("upper")
    boll_mid = boll.get("mid")
    boll_lower = boll.get("lower")
    # MACD 状态
    macd_state = "中位"
    if dif is not None and dea is not None:
        if dif > dea and (hist is None or hist > 0):
            macd_state = "金叉红柱" if (dif - dea) > 0.1 else "红柱收敛"
        elif dif < dea and (hist is None or hist < 0):
            macd_state = "死叉绿柱" if (dea - dif) > 0.1 else "绿柱收敛"
        elif dif > 0:
            macd_state = "0轴上"
        else:
            macd_state = "0轴下"
    # KDJ 状态
    kdj_state = "中位"
    if k_v is not None:
        if k_v > 80:
            kdj_state = f"超买(K={k_v:.0f})"
        elif k_v < 20:
            kdj_state = f"超卖(K={k_v:.0f})"
    # BOLL 位置
    boll_pos = "中轨"
    if price is not None:
        if boll_upper and price >= boll_upper:
            boll_pos = "上轨"
        elif boll_lower and price <= boll_lower:
            boll_pos = "下轨"
    # 支撑 / 压力位（优先用 tl 的 open/buy/sell，再用 price_levels）
    support = None
    resist = None
    if tl:
        support = tl.get("low") or tl.get("buy")
        resist = tl.get("high") or tl.get("sell")
    if not support and pl:
        support = pl.get("support")
    if not resist and pl:
        resist = pl.get("resist")
    # MA20 兜底
    if not support and ma20:
        support = round(ma20 * 0.98, 2)
    if not resist and ma20:
        resist = round(ma20 * 1.05, 2)
    return {
        "ma5": round(ma5, 2) if ma5 else None,
        "ma10": round(ma10, 2) if ma10 else None,
        "ma20": round(ma20, 2) if ma20 else None,
        "macd_state": macd_state,
        "kdj_state": kdj_state,
        "boll_pos": boll_pos,
        "boll_upper": round(boll_upper, 2) if boll_upper else None,
        "boll_mid": round(boll_mid, 2) if boll_mid else None,
        "boll_lower": round(boll_lower, 2) if boll_lower else None,
        "support": support,
        "resist": resist,
    }


def _advise_position(code, capital):
    """为单只持仓计算完整操作建议：买/卖/不动 + 操作价 + 操作量 + 行业强弱。

    综合：当天 KDJ/量/资金/MACD 等技术面 + 行业资金流入流出与龙头走势
    （sector_strength）+ 用户可用资金/持仓（position_advice 算量）。
    返回 dict；K线不足时返回 {ok:False}。
    """
    period, limit = "daily", 120
    bars = _cache_get(code, period, limit) or ds.get_kline(code, period, limit, _tdx_path or None)
    _cache_set(code, period, limit, bars)
    a = sig.analyze(bars, _WEIGHTS)
    if not a.get("ok"):
        return {"code": code, "ok": False, "reason": a.get("msg", "K线不足，无法研判")}
    # 行业强弱（资金流+龙头涨跌）
    try:
        _fp = ip.get_fund(code) or {}
        _ss = sf.sector_strength(_fp.get("track")) if _fp.get("track") else None
    except Exception:
        _fp, _ss = {}, None
    price = a.get("price")
    prev_close = a.get("prev_close")
    regime = None
    if _ss:
        regime = {"track": _ss.get("track"), "sector": _ss.get("sector"),
                  "trend_pct": _ss.get("trend_pct"), "fund_net": _ss.get("fund_net"),
                  "up_ratio": _ss.get("up_ratio")}
    # 动态买卖价（移动止盈/支撑跟随，避免「卖价死板卖飞」，如永鼎 38.55→40.11）
    try:
        bars5m = _cache_get(code, "5m", 60) or ds.get_kline(code, "5m", 60, _tdx_path or None)
        _cache_set(code, "5m", 60, bars5m)
        tl = sig.dynamic_levels(bars, bars5m, price, prev_close, regime)
    except Exception:
        tl = None
    adp = sig.adaptive_trade(tl, regime, price, prev_close, pct=0.03)
    outlook = sig.day_outlook(a, regime, tl, adp, price, prev_close)
    held = _held_shares(code)
    pos = sig.position_advice(a["score"], a["action"], price,
                              capital=capital, max_single=_POS.get("max_single", 0.25),
                              current_shares=held, lot=_POS.get("lot", 100))
    # 收敛为 买/卖/不动
    if adp.get("bias") == "defensive":
        action = "卖出"
    elif outlook and outlook.get("action") == "买":
        action = "买入"
    elif outlook and outlook.get("action") == "卖":
        action = "卖出"
    else:
        action = "不动"
    # 操作价：买用当日买点/支撑，卖用当日卖点/阻力 —— 价格必须约束在当前价 ±3% 内，
    # 否则当天到不了那个价。建议卖出/买入是"现在/明天可执行"的动作，不是看天价。
    pl = a.get("price_levels") or {}
    if action == "买入":
        op_price = (tl or {}).get("buy") or pl.get("buy")
    elif action == "卖出":
        op_price = (tl or {}).get("sell") or pl.get("sell")
    else:
        op_price = None
    if op_price and price:
        # 卖出不能高于现价 +3%（否则永远到不了），买入不能低于现价 -3%（追跌不接飞刀）
        if action == "卖出" and op_price > price * 1.03:
            op_price = round(price * 1.015, 2)  # 弱市/超买保守一点
        elif action == "买入" and op_price < price * 0.97:
            op_price = round(price * 0.985, 2)
    # 操作量：买=加仓股数，卖=减仓股数（不超持仓），不动=0
    delta = int(pos.get("delta_shares") or 0)
    if action == "买入":
        op_qty = max(0, delta)
    elif action == "卖出":
        op_qty = min(max(0, -delta), held)
    else:
        op_qty = 0
    if action in ("买入", "卖出") and op_qty <= 0:
        action, op_qty = "不动", 0
    # 盘中实时建议（5min 分时级别，看一眼该买/卖/等的瞬时判断）
    intraday = _intraday_for(code, price, prev_close)
    # ===== 加减分评估：技术面 + 板块资金净流 + 当日赛道涨跌 → 输出 -100~+100 =====
    #    +100 必加仓、-100 必减仓、0 持平持有
    if action == "买入":
        base = 70
    elif action == "卖出":
        base = -70
    else:
        base = 0
    tech_adj = (a["score"] - 50) * 0.5                # 技术评分（0-100）→ -25..+25
    fund_adj = 0
    if regime:
        tpct = regime.get("trend_pct")
        if tpct is not None:
            fund_adj += max(-18, min(18, tpct * 3))    # 当日赛道涨跌% × 3 → -18..+18
        fn = regime.get("fund_net")
        if fn is not None:
            fund_adj += max(-12, min(12, fn * 8))      # 大类行业净流入亿 × 8 → -12..+12
    advice_score = int(max(-100, min(100, base + tech_adj + fund_adj)))
    # 中文动作标签
    action_label = "加仓" if action == "买入" else ("减仓" if action == "卖出" else "持有")
    # 所属行业今日信息（赛道涨跌/资金净流/上涨占比）
    industry_today = None
    if regime:
        industry_today = {
            "sector": regime.get("sector"),
            "track": regime.get("track"),
            "trend_pct": regime.get("trend_pct"),       # 当日细分赛道平均涨跌%（正值涨/负值跌）
            "fund_net": regime.get("fund_net"),         # 行业大类（科技/医药/电力）当日资金净流入（亿元，本地为估算）
            "fund_proxy": regime.get("fund_proxy", False),  # True=本地估算(东财不可用时)
            "up_ratio": regime.get("up_ratio"),         # 赛道成分股上涨占比（0~1）
        }
    # ===== 今日预估（涨/跌/震荡 + pct + 依据）=====
    forecast = _build_forecast(a, regime, outlook, prev_close, action)
    # ===== 板块详情（涨跌幅 + 资金净流入 + 上涨占比）=====
    sector_detail = _build_sector_detail(regime)
    # ===== 技术面（MA + MACD + KDJ + BOLL + 关键支撑压力位）=====
    technical = _build_technical(a, tl, pl, price)
    return {
        "code": code, "ok": True,
        "name": _fp.get("name") or code,
        "shares": held,
        "price": price,
        "action": action,
        "action_label": action_label,
        "advice_score": advice_score,
        "action5": a["action"],
        "score": a["score"],
        "op_price": round(op_price, 2) if op_price else None,
        "op_qty": op_qty,
        "op_basis": (tl or {}).get("basis") or "",
        "reason": (outlook or {}).get("reason") or (a.get("reasons")[0]["text"] if a.get("reasons") else ""),
        "regime": regime,
        "industry_today": industry_today,
        "indicators": a.get("indicators"),
        "intraday": intraday,
        "forecast": forecast,
        "sector_detail": sector_detail,
        "technical": technical,
    }


# ---------- 盘中实时建议（高频刷新，按分时判断该不该买/卖） ----------
def _intraday_for(code, price=None, prev_close=None, period="1m"):
    """对单只股票计算盘中实时建议（场景+动作+价+止损+原因）。

    优先用实时行情（腾讯实时接口）做"这一刻"的价；分时图（默认 1min K 线，可切 5m）做动作判断。
    """
    try:
        quote = ds.fetch_realtime([code]).get(code) or {}
    except Exception:
        quote = {}
    if price is None:
        price = quote.get("price")
    if prev_close is None:
        prev_close = quote.get("prev_close") or price
    if not price or not prev_close:
        return {"scenario": "数据不足", "reasons": ["实时价或昨收缺失"]}
    try:
        if period == "1m":
            # 1 分钟线：东财在线，但加 25 秒内存缓存——避免每 5 秒轮询都重新现拉（曾导致面板一直"加载中"）
            bars = _cache_get(code, "1m", 60)
            if bars is None:
                bars = ds.get_kline(code, period, 60)
                _cache_set(code, "1m", 60, bars)
        else:
            bars = _cache_get(code, period, 60) or ds.get_kline(code, period, 60, _tdx_path or None)
            _cache_set(code, period, 60, bars)
    except Exception:
        bars = []
    if not quote:
        quote = {"code": code, "price": price, "prev_close": prev_close,
                 "high": price, "low": price, "open": prev_close, "volume": 0}
    return intraday_mod.intraday_advice(quote, bars or [], prev_close)


# ---------- 尾盘策略汇总（14:30-15:00 自动给出：减仓哪几只 / 埋伏哪 1 只） ----------
TAIL_WATCH_CODES = [
    "sz002371",  # 北方华创 半导体设备
    "sz002463",  # 沪电股份 PCB
    "sz002281",  # 光迅科技 光模块
    "sh601138",  # 工业富联 AI算力
    "sz000063",  # 中兴通讯 通信
    "sh600276",  # 恒瑞医药 创新药
    "sh603259",  # 药明康德 CXO
    "sh600111",  # 北方稀土 稀土
    "sh603986",  # 兆易创新 芯片
    "sh600487",  # 亨通光电 光纤
    "sz002050",  # 三花智控 机器人
    "sh600436",  # 片仔癀 中药
]


def _market_phase():
    """当前 A 股时段描述。"""
    from datetime import datetime
    now = datetime.now()
    if now.weekday() >= 5:
        return "休市（周末）"
    hm = now.hour * 60 + now.minute
    if 570 <= hm <= 690:
        return "盘中（上午）"
    if 690 < hm < 780:
        return "午间休市"
    if 780 <= hm <= 870:
        return "盘中"
    if 870 < hm <= 900:
        return "尾盘"
    if hm > 900:
        return "已收盘"
    return "等待开盘"


def _is_trading_now():
    from datetime import datetime
    now = datetime.now()
    if now.weekday() >= 5:
        return False
    hm = now.hour * 60 + now.minute
    return (570 <= hm <= 690) or (780 <= hm <= 900)


def _is_closed():
    """已收盘（周末或 15:00 后）：停止拉分时/盘中建议。"""
    from datetime import datetime
    now = datetime.now()
    if now.weekday() >= 5:
        return True
    return now.hour >= 15


def _tail_market_strategy():
    """汇总尾盘策略：持仓该减仓哪几只 + 候选池低位埋伏哪 1 只。"""
    import concurrent.futures as _cf
    from datetime import datetime
    phase = _market_phase()
    trading = _is_trading_now()
    positions = _load_positions() or []
    held = {p.get("code") for p in positions}

    # 15:00 后停止尾盘扫描（仅 14:30-15:00 有意义，避免收盘后还去扫 391 只全池）
    if _is_closed():
        return {
            "ts": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "phase": "已收盘",
            "trading": False,
            "positions": [], "reduce_list": [], "hold_list": [],
            "buries": [], "conclusion": "已收盘，尾盘策略已停止更新。", "empty": True,
        }

    # 1) 持仓分时（5m 更稳，避免 1m 抖动）
    def _one_pos(p):
        code = p.get("code")
        name = p.get("name") or (ip.get_fund(code) or {}).get("name") or code
        try:
            it = _intraday_for(code, period="5m")
        except Exception:
            it = {}
        return code, name, it
    pos_rows, reduce, hold = [], [], []
    if positions:
        with _cf.ThreadPoolExecutor(max_workers=6) as ex:
            for code, name, it in ex.map(_one_pos, positions):
                m = it.get("metrics", {}) or {}
                act = it.get("action", "持有观察")
                row = {
                    "code": code, "name": name,
                    "now_pct": m.get("now_pct"),
                    "scenario": it.get("scenario"),
                    "action": act,
                    "urgency": it.get("urgency"),
                    "target_price": it.get("target_price"),
                    "stop_loss": it.get("stop_loss"),
                    "action_color": it.get("action_color"),
                    "kdj_j": m.get("kdj_j"),
                }
                pos_rows.append(row)
                if "止盈" in act or "卖出" in act:
                    reduce.append(row)
                else:
                    hold.append(row)

    # 2) 埋伏候选：扫描「十五五行业池」全量（约 391 只），两阶段筛选
    #    stage1 日线预筛（并发拉日K，磁盘按天缓存）→ stage2 对预筛 top 做盘中明细打分
    from core.daily_strategy import _tech_score_daily, _load_pool
    _pool = _load_pool() or []
    pool_codes = [p.get("code") for p in _pool if p.get("code") and p.get("code") not in held]
    def _daily_score(c):
        try:
            bars = ds.get_kline(c, "daily", 40)
        except Exception:
            bars = []
        q = {}
        try:
            q = ds.fetch_realtime([c]).get(c, {}) or {}
        except Exception:
            q = {}
        try:
            score, sig, ob, os_ = _tech_score_daily(bars, q)
        except Exception:
            return c, -99, False
        return c, score, os_
    pref = []
    if pool_codes:
        with _cf.ThreadPoolExecutor(max_workers=8) as ex:
            for c, score, os_ in ex.map(_daily_score, pool_codes):
                if score <= -99:
                    continue
                if score <= -2:        # 明显转弱不埋伏
                    continue
                if not (os_ or score >= 1):
                    continue
                pref.append((c, score))
    pref.sort(key=lambda x: x[1], reverse=True)
    cand_top = [c for c, _ in pref[:60]]
    candidates = cand_top
    def _one_cand(c):
        f = ip.get_fund(c) or {}
        try:
            it = _intraday_for(c, period="5m")
        except Exception:
            it = {}
        return c, f.get("name") or c, f.get("track") or "", it
    buries = []
    if cand_top:
        with _cf.ThreadPoolExecutor(max_workers=8) as ex:
            for c, name, track, it in ex.map(_one_cand, cand_top):
                if not it or it.get("scenario") == "数据不足":
                    continue
                m = it.get("metrics", {}) or {}
                act = it.get("action", "")
                now_pct = m.get("now_pct")
                kdj_j = m.get("kdj_j")
                vol = m.get("vol_ratio")
                if now_pct is None:
                    continue
                if now_pct > 3:                       # 已涨多不埋伏
                    continue
                if kdj_j is not None and kdj_j >= 90:  # 超买不埋伏
                    continue
                if "止盈" in act or "卖出" in act:
                    continue
                score = 0
                if now_pct < 0:
                    score += 3
                if kdj_j is not None and kdj_j < 40:
                    score += 3
                if vol is not None and vol < 1.0:
                    score += 1
                if "低吸" in act or "加仓" in act:
                    score += 4
                if now_pct < 0 and vol is not None and vol < 0.8:
                    score += 2
                reason = ""
                if now_pct < 0:
                    reason = f"日内 {now_pct}% 回落至低位"
                elif now_pct <= 1:
                    reason = f"日内 +{now_pct}%，蓄势"
                if kdj_j is not None:
                    reason += f"；KDJ J={kdj_j}"
                buries.append({
                    "code": c, "name": name, "track": track,
                    "now_pct": now_pct, "kdj_j": kdj_j, "vol_ratio": vol,
                    "scenario": it.get("scenario"), "action": act,
                    "target_price": it.get("target_price"),
                    "stop_loss": it.get("stop_loss"),
                    "action_color": it.get("action_color"),
                    "reason": reason, "score": score,
                })
    buries.sort(key=lambda x: x["score"], reverse=True)
    buries = buries[:3]

    # 3) 综合结论
    n_reduce = len(reduce)
    if not trading:
        conclusion = f"当前{phase}，行情未开。尾盘策略仅在交易时段（尤其 14:30–15:00）有效，开盘后再来看。"
        empty = True
    else:
        if n_reduce >= 2:
            concl = f"今日持仓 {n_reduce} 只触发止盈/卖出信号，尾盘以『减仓落袋』为主，不宜追高加仓；"
        elif n_reduce == 1:
            concl = f"持仓中 1 只（{reduce[0]['name']}）触发止盈，其余持有观察；"
        else:
            concl = "持仓暂未触发明显止盈信号，可继续持有观察；"
        if buries:
            top = buries[0]
            concl += f"若要用尾盘仓位埋伏，优先看【{top['name']}】（{top['track']}，{top['reason']}），建议小仓（约 1/5）分批，止损参考 {top['stop_loss'] or '—'}。"
        else:
            concl += "扫描候选当前多在高位或信号不明显，尾盘建议空仓观望、不盲目买入。"
        conclusion = concl
        empty = False

    return {
        "ts": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "phase": phase,
        "trading": trading,
        "positions": pos_rows,
        "reduce_list": reduce,
        "hold_list": hold,
        "buries": buries,
        "conclusion": conclusion,
        "empty": empty,
    }


# ---------- 请求处理 ----------
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # 静默

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False)
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path, ctype):
        try:
            with open(path, "rb") as f:
                data = f.read()
        except Exception:
            self._send(404, {"error": "not found"})
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        # 必须每次重新校验 → 解决"我代码改了用户看不到得强刷/重启"的踩坑
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        parsed = urlparse(self.path)
        route = parsed.path
        qs = parse_qs(parsed.query)

        if route == "/" or route == "/index.html":
            self._send_file(os.path.join(BASE, "static", "index.html"),
                            "text/html; charset=utf-8")
            return
        if route.startswith("/static/"):
            self._static(route[8:])
            return

        if route == "/api/config":
            self._send(200, {"tdx_path": _tdx_path, "tdx_available": _tdx_available,
                             "market": "A股（沪深）",
                             "position": _POS, "monitor": _MON,
                             "strategies": sig.STRATEGY_LABELS,
                             "weight_categories": sig.WEIGHT_CATEGORIES,
                             "weight_multipliers": _WEIGHT_MULT,
                             "available_capital": _config.get("available_capital", 100000),
                             "cloud_url": _CLOUD_URL})
            return
        if route == "/api/positions":
            self._send(200, _load_positions())
            return
        if route == "/api/positions_advice":
            # 批量持仓建议：一次返回所有持仓的 买/卖/不动 + 操作价 + 操作量 + 行业强弱 + 实时价
            try:
                capital = float(qs.get("capital", [None])[0] or _config.get("available_capital", 100000))
            except (TypeError, ValueError):
                capital = _config.get("available_capital", 100000)
            positions = _load_positions()
            codes = [p.get("code") for p in positions if p.get("code")]
            rt = {}
            if codes:
                try:
                    rt = ds.fetch_realtime(codes) or {}
                except Exception:
                    rt = {}
            out = []
            total_value = 0.0
            for p in positions:
                code = p.get("code")
                adv = _advise_position(code, capital)
                price = (rt.get(code) or {}).get("price")
                change_pct = (rt.get(code) or {}).get("change_pct")
                shares = int(p.get("shares", 0) or 0)
                cost = float(p.get("cost", 0) or 0)
                if price is None:
                    price = adv.get("price")
                if price is not None:
                    adv["price"] = price
                    adv["change_pct"] = change_pct
                adv["name"] = p.get("name") or adv.get("name") or code
                adv["shares"] = shares
                adv["cost"] = cost
                # 基本面/预期事实（PE + 机构目标价 + 新闻，best-effort，带缓存）
                try:
                    adv["facts"] = _stock_facts(code)
                except Exception:
                    adv["facts"] = None
                # 每日复盘快照：记录开盘建议/最高/最低，收盘后(>=15:00)自动记收盘
                try:
                    rq = rt.get(code) or {}
                    _capture_review({
                        "code": code, "name": adv["name"],
                        "price": price, "high": rq.get("high"), "low": rq.get("low"),
                        "action": adv.get("action"), "op_price": adv.get("op_price"),
                        "op_qty": adv.get("op_qty"),
                    })
                except Exception:
                    pass
                total_value += (price or 0) * shares
                out.append(adv)
            # ---------- 账户现金 + 真实当日盈亏 ----------
            # 当日盈亏 = (现价×股数 + 现金) − (昨收×开盘基准股数 + 开盘基准现金)
            # 开盘基准快照在"新的一天首次访问"时自动记录，之后只随交易更新当前态，
            # 因此盘中买卖后盈亏自动准确（无需对接券商，由用户录入交易驱动）。
            acct = _load_account()
            today = _today_str()
            if acct.get("baseline_date") != today:
                acct["baseline_date"] = today
                acct["baseline_cash"] = acct.get("cash", 0)
                acct["baseline_shares"] = {
                    p.get("code"): int(p.get("shares", 0) or 0) for p in positions
                }
                _sync_account(acct)
            cash = float(acct.get("cash", 0) or 0)
            # 基准市值：以"昨收"给开盘股数估值
            base_value = float(acct.get("baseline_cash", 0) or 0)
            for code, sh in (acct.get("baseline_shares") or {}).items():
                q = rt.get(code) or {}
                pc = q.get("prev_close")
                if pc is None:
                    px = q.get("price")
                    cp = q.get("change_pct")
                    pc = (px / (1 + cp / 100)) if (px and cp is not None) else 0
                base_value += (pc or 0) * sh
            cur_value = cash + total_value
            daily_pnl = round(cur_value - base_value, 2)
            daily_pnl_pct = round(daily_pnl / base_value * 100, 2) if base_value else 0.0
            self._send(200, {"ok": True, "capital": capital, "cash": cash,
                             "market_value": round(total_value, 2),
                             "total_value": round(cur_value, 2),
                             "daily_pnl": daily_pnl, "daily_pnl_pct": daily_pnl_pct,
                             "count": len(out), "positions": out})
            return
        if route == "/api/search":
            q = qs.get("q", [""])[0]
            self._send(200, ds.search(q) if q else [])
            return
        if route == "/api/kline":
            code = qs.get("code", [""])[0]
            period = qs.get("period", ["daily"])[0]
            limit = int(qs.get("limit", ["300"])[0])
            if not code:
                self._send(400, {"error": "code required"})
                return
            bars = _cache_get(code, period, limit)
            if bars is None:
                bars = ds.get_kline(code, period, limit, _tdx_path or None)
                _cache_set(code, period, limit, bars)
            ind = compute_all(bars) if bars else None
            self._send(200, {"code": code, "period": period, "bars": bars, "indicators": ind})
            return
        if route == "/api/quotes":
            codes = qs.get("codes", [""])[0].replace(" ", ",").split(",")
            codes = [c for c in codes if c]
            self._send(200, ds.fetch_realtime(codes))
            return
        if route == "/api/signal":
            code = qs.get("code", [""])[0]
            period = qs.get("period", ["daily"])[0]
            limit = int(qs.get("limit", ["120"])[0])
            if not code:
                self._send(400, {"error": "code required"})
                return
            bars = _cache_get(code, period, limit) or ds.get_kline(code, period, limit, _tdx_path or None)
            _cache_set(code, period, limit, bars)
            a = sig.analyze(bars, _WEIGHTS)
            if a.get("ok"):
                a["position"] = _build_position(a, qs, code)
                # 当日板块强弱（资金流+龙头涨跌），做T计划与自适应建议共用
                try:
                    _fp = ip.get_fund(code) or {}
                    _ss = sf.sector_strength(_fp.get("track")) if _fp.get("track") else None
                except Exception:
                    _fp, _ss = {}, None
                regime = None
                if _ss:
                    regime = {"track": _ss.get("track"), "sector": _ss.get("sector"),
                              "trend_pct": _ss.get("trend_pct"), "fund_net": _ss.get("fund_net"),
                              "up_ratio": _ss.get("up_ratio")}
                # 当日实时买卖价：动态（移动止盈/支撑跟随，避免「卖价死板卖飞」如永鼎 38.55→40.11）
                # 基于日K(含volume)计算，5m 仅用于取开盘价；5m 缺失也不影响买卖价输出
                try:
                    bars5m = _cache_get(code, "5m", 60) or ds.get_kline(code, "5m", 60, _tdx_path or None)
                    _cache_set(code, "5m", 60, bars5m)
                    tl = sig.dynamic_levels(bars, bars5m, a.get("price"), a.get("prev_close"), regime)
                except Exception:
                    tl = None
                a["today"] = tl
                if a.get("position") and tl:
                    a["position"]["today_buy"] = tl.get("buy")
                    a["position"]["today_sell"] = tl.get("sell")
                    a["position"]["today_open"] = tl.get("open")
                    a["position"]["today_basis"] = tl.get("basis")
                    a["position"]["today_mode"] = tl.get("mode")
                # 自适应买卖建议：板块资金流出+下跌 → 先减仓防跌，跌停才低吸买回
                adp = sig.adaptive_trade(tl, regime, a.get("price"), a.get("prev_close"), pct=0.03)
                a["regime"] = regime
                a["adaptive"] = adp
                # 今日研判：技术面(MACD/BOLL/KDJ)+板块资金流+当日带宽 → 偏多/偏空/震荡 + 当前买/卖/不动
                a["outlook"] = sig.day_outlook(a, regime, tl, adp, a.get("price"), a.get("prev_close"))
                if a.get("position"):
                    a["position"]["regime"] = regime
                    a["position"]["adaptive"] = adp
                # 持仓做T计划：15m 日内区间 + 日线支撑阻力 + 行业趋势
                try:
                    bars15 = _cache_get(code, "15m", 60) or ds.get_kline(code, "15m", 60, _tdx_path or None)
                    _cache_set(code, "15m", 60, bars15)
                    a["t_plan"] = sig.build_t_plan(a, bars15, a.get("price") or 0,
                                                  _held_shares(code),
                                                  capital=_POS.get("capital", 100000),
                                                  lot=_POS.get("lot", 100),
                                                  sector_strength=_ss)
                except Exception:
                    a["t_plan"] = {"t_action": "持有不动", "t_buy_price": None,
                                   "t_sell_price": None, "t_qty": 0,
                                   "t_note": "做T计算暂不可用"}
            self._send(200, a)
            return
        if route == "/api/advice":
            code = qs.get("code", [""])[0]
            if not code:
                self._send(400, {"error": "code required"})
                return
            period = qs.get("period", ["daily"])[0]
            limit = int(qs.get("limit", ["120"])[0])
            bars = _cache_get(code, period, limit) or ds.get_kline(code, period, limit, _tdx_path or None)
            _cache_set(code, period, limit, bars)
            a = sig.analyze(bars, _WEIGHTS)
            if not a.get("ok"):
                self._send(200, a)
                return
            adv = {"code": code, "action": a["action"], "score": a["score"],
                   "price": a["price"], "position": _build_position(a, qs, code),
                   "reasons": [r["text"] for r in a["reasons"]]}
            self._send(200, adv)
            return
        if route == "/api/watchlist":
            self._send(200, _load_watchlist())
            return
        if route == "/api/screener":
            scope = qs.get("scope", ["watchlist"])[0]
            strategy = qs.get("strategy", ["composite"])[0]
            limit = int(qs.get("limit", ["120"])[0])
            codes = _scope_codes(scope)
            # 候选股（十五五成长池）：技术+基本面综合打分，走后台异步，前端轮询进度
            if scope == "candidate":
                try:
                    cap = float(qs.get("capital", [None])[0] or _config.get("available_capital", 100000))
                except (TypeError, ValueError):
                    cap = _config.get("available_capital", 100000)
                if not _scan["running"]:
                    _scan["running"] = True
                    _scan["results"] = []
                    _scan["error"] = None
                    _scan["started"] = time.time()
                    _scan["scope"] = "candidate"
                    _scan["strategy"] = strategy
                    t = threading.Thread(target=self._run_candidate_bg,
                                         args=(codes, limit, cap, strategy), daemon=True)
                    t.start()
                self._send(200, {"running": True, "total": len(codes) or _scan["total"],
                                 "done": _scan.get("done", 0),
                                 "results": _scan.get("results", [])[:200],
                                 "scope": "candidate",
                                 "strategy": strategy,
                                 "strategy_label": sig.STRATEGY_LABELS.get(strategy, strategy)})
                return
            if not codes:
                self._send(200, {"scope": scope, "strategy": strategy,
                                 "strategy_label": sig.STRATEGY_LABELS.get(strategy, strategy),
                                 "count": 0, "results": []})
                return
            # 大范围（全市场/通达信/大股票池）走后台异步扫描，前端轮询进度
            big = scope in ("online_all", "tdx", "universe") and len(codes) > 200
            if big:
                if not _scan["running"]:
                    _scan["running"] = True
                    _scan["results"] = []
                    _scan["error"] = None
                    _scan["started"] = time.time()
                    _scan["scope"] = scope
                    _scan["strategy"] = strategy
                    t = threading.Thread(target=self._scan_all_worker,
                                         args=(codes, limit, strategy), daemon=True)
                    t.start()
                self._send(200, {"running": True, "total": _scan["total"] or len(codes),
                                 "done": _scan["done"],
                                 "results": _scan["results"][:200],
                                 "strategy_label": sig.STRATEGY_LABELS.get(strategy, strategy)})
                return
            result = self._run_screener(codes, limit, strategy)
            self._send(200, {"scope": scope, "strategy": strategy,
                             "strategy_label": sig.STRATEGY_LABELS.get(strategy, strategy),
                             "count": len(codes), "results": result})
            return
        if route == "/api/scan_status":
            self._send(200, {"running": _scan["running"], "total": _scan["total"],
                             "done": _scan["done"], "results": _scan["results"][:200],
                             "error": _scan["error"], "scope": _scan["scope"],
                             "strategy": _scan["strategy"]})
            return
        if route == "/api/build_universe":
            u = os.path.join(DATA_DIR, "universe.txt")
            try:
                codes = ds.refresh_universe(u)
            except Exception as e:
                self._send(200, {"ok": False, "error": str(e)})
                return
            global _universe_cache
            _universe_cache = codes
            self._send(200, {"ok": True, "count": len(codes)})
            return
        if route == "/api/alerts":
            self._send(200, _load_json(ALERTS, []))
            return
        if route == "/api/alerts/check":
            self._send(200, self._check_alerts())
            return
        if route == "/api/review":
            date = qs.get("date", [""])[0] or None
            self._send(200, _review_summary(date))
            return
        if route == "/api/tail_market_strategy":
            self._send(200, _tail_market_strategy())
            return
        if route == "/api/daily_strategy":
            # 自动维护当日记录（缺失的开盘判断/已过时点快照/收盘复盘各生成一次）后返回
            try:
                day = run_daily("auto")
            except Exception as e:
                day = {"error": str(e)}
            self._send(200, day)
            return
        if route == "/api/daily_strategy/open":
            try:
                self._send(200, open_judgment())
            except Exception as e:
                self._send(200, {"error": str(e)})
            return
        if route == "/api/daily_strategy/snapshot":
            t = qs.get("t", [""])[0].strip() or None
            try:
                self._send(200, generate_snapshot(t) if t else run_daily("snapshot"))
            except Exception as e:
                self._send(200, {"error": str(e)})
            return
        if route == "/api/daily_strategy/review":
            try:
                self._send(200, generate_review())
            except Exception as e:
                self._send(200, {"error": str(e)})
            return
        if route == "/api/intraday_advice_batch":
            # 15:00 后停止拉分时/盘中建议（用户要求：收盘即停更）
            if _is_closed():
                self._send(200, {"closed": True, "message": "已收盘，分时建议已停止更新"})
                return
            # 批量盘中建议：一次请求并发算所有持仓（线程池），避免前端对每只发独立请求、叠加 1m 现拉导致一直"加载中"
            raw_codes = qs.get("codes", [""])[0].strip()
            period = qs.get("period", ["1m"])[0].strip().lower()
            if period not in ("1m", "5m", "15m", "30m", "60m"):
                period = "1m"
            codes = [c.strip().lower() for c in raw_codes.split(",") if c.strip()]
            if not codes:
                self._send(400, {"error": "codes required"}); return
            from concurrent.futures import ThreadPoolExecutor
            # 先一次性批量取所有实时价（一次请求，避免并发打腾讯实时接口被干扰导致"数据不足"）
            rt = {}
            try:
                rt = ds.fetch_realtime(codes) or {}
            except Exception:
                rt = {}
            results = {}
            def _one(c):
                q = rt.get(c) or {}
                r = _intraday_for(c, price=q.get("price"), prev_close=q.get("prev_close"), period=period)
                r["code"] = c
                r["period"] = period
                return c, r
            try:
                with ThreadPoolExecutor(max_workers=min(len(codes), 6)) as ex:
                    for c, r in ex.map(_one, codes):
                        results[c] = r
            except Exception as e:
                print("[WARN] intraday batch partial:", e)
            self._send(200, {"period": period, "results": results})
            return
        if route == "/api/intraday_advice":
            # 15:00 后停止拉分时/盘中建议
            if _is_closed():
                self._send(200, {"closed": True, "message": "已收盘，分时建议已停止更新"})
                return
            # 盘中实时建议：基于 1min/5min K 线 + 实时价，给"该不该买/卖"的瞬时判断
            code = qs.get("code", [""])[0].strip().lower()
            if not code:
                self._send(400, {"error": "code required"}); return
            period = qs.get("period", ["1m"])[0].strip().lower()
            if period not in ("1m", "5m", "15m", "30m", "60m"):
                period = "1m"
            # 复用 _intraday_for：自动取实时价 + 指定周期 K 线
            res = _intraday_for(code, period=period)
            res["code"] = code
            res["period"] = period
            self._send(200, res)
            return
        self._send(404, {"error": "unknown route"})

    def do_POST(self):
        parsed = urlparse(self.path)
        route = parsed.path
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            text = raw.decode("gbk", "replace")  # 兼容 Windows 终端以 GBK 发送的中文
        try:
            payload = json.loads(text) if raw else {}
        except Exception:
            payload = {}

        if route == "/api/watchlist":
            # 增量添加（从扫描「加自选」按钮调用）：保留已有元数据
            if isinstance(payload, dict) and payload.get("items") is not None:
                items = payload["items"]
                existing = {w["code"]: w for w in _load_watchlist()}
                for it in items:
                    c = str(it.get("code", ""))
                    if not c:
                        continue
                    rec = existing.get(c) or {"code": c, "name": "", "add_time": None,
                                             "add_price": None, "scan_buy": None}
                    rec["name"] = it.get("name") or rec.get("name") or ""
                    if it.get("add_time"):
                        rec["add_time"] = it["add_time"]
                    if it.get("add_price") is not None:
                        rec["add_price"] = it["add_price"]
                    if it.get("scan_buy") is not None:
                        rec["scan_buy"] = it["scan_buy"]
                    existing[c] = rec
                _sync_watchlist(list(existing.values()))
                self._send(200, {"ok": True, "items": list(existing.values())})
                return
            # 全量替换（兼容旧接口 / 前端保存列表）
            codes = payload.get("codes", []) if isinstance(payload, dict) else payload
            norm = []
            for c in codes:
                if isinstance(c, dict) and c.get("code"):
                    norm.append(c)
                elif c:
                    norm.append({"code": str(c), "name": "", "add_time": None,
                                 "add_price": None, "scan_buy": None})
            _sync_watchlist(norm)
            self._send(200, {"ok": True, "codes": [n["code"] for n in norm]})
            return
        if route == "/api/config":
            # 保存权重倍率 / 仓位参数 / 监控 / 云端地址 / 通达信路径
            if isinstance(payload, dict):
                try:
                    if "weight_multipliers" in payload:
                        _config["weight_multipliers"] = payload["weight_multipliers"]
                    if "position" in payload:
                        _config["position"] = payload["position"]
                    if "monitor" in payload:
                        _config["monitor"] = payload["monitor"]
                    if "cloud_url" in payload:
                        _config["cloud_url"] = payload["cloud_url"]
                    if "available_capital" in payload:
                        try:
                            _config["available_capital"] = float(payload["available_capital"])
                        except (TypeError, ValueError):
                            pass
                    if "tdx_path" in payload:
                        _config["tdx_path"] = payload["tdx_path"]
                    try:
                        _save_json(CONFIG, _config)
                    except Exception as e:
                        print("[WARN] save config failed:", e)
                    global _WEIGHTS, _WEIGHT_MULT, _POS, _MON, _CLOUD_URL, _tdx_path, _tdx_available
                    _WEIGHT_MULT = _config.get("weight_multipliers") or {}
                    _WEIGHTS = sig.expand_weights(_WEIGHT_MULT)
                    _POS = _config.get("position") or _POS
                    _MON = _config.get("monitor") or _MON
                    _CLOUD_URL = _config.get("cloud_url", "") or ""
                    _tdx_path = _config.get("tdx_path", "") or ""
                    _tdx_available = bool(_tdx_path) and os.path.isdir(_tdx_path)
                except Exception as e:
                    print("[ERROR] config update failed:", e)
            self._send(200, {"ok": True, "tdx_available": _tdx_available})
            return
        if route == "/api/positions":
            item = payload if isinstance(payload, dict) else {}
            code = str(item.get("code", ""))
            if not code:
                self._send(400, {"error": "code required"})
                return
            positions = _load_positions()
            rec = {"code": code, "name": item.get("name", ""),
                   "shares": int(item.get("shares", 0) or 0),
                   "cost": float(item.get("cost", 0) or 0)}
            found = False
            for i, p in enumerate(positions):
                if p.get("code") == code:
                    positions[i] = rec
                    found = True
                    break
            if not found:
                positions.append(rec)
            # 双写：runtime（data/，本地/沙箱持久生效）+ 主源（static/，云端部署后自动同步）
            _save_json(POSITIONS, positions)
            try:
                _save_json(STATIC_POSITIONS, positions)
            except Exception as e:
                print("[WARN] static positions write failed (cloud may be read-only):", e)
            self._send(200, {"ok": True, "positions": positions})
            return
        if route == "/api/trade":
            # 当日交易录入：买入=加股数/重算成本/现金减；卖出=减股数/现金加。
            # 买卖后前端重拉 /api/positions_advice，真实当日盈亏自动更新。
            item = payload if isinstance(payload, dict) else {}
            code = str(item.get("code", "")).strip().lower()
            if not code:
                self._send(400, {"error": "code required"})
                return
            side = item.get("side", "buy")
            if side not in ("buy", "sell"):
                self._send(400, {"error": "side must be buy/sell"})
                return
            try:
                price = float(item.get("price", 0) or 0)
                qty = int(item.get("qty", 0) or 0)
            except (TypeError, ValueError):
                self._send(400, {"error": "price/qty 非法"})
                return
            if qty <= 0 or price <= 0:
                self._send(400, {"error": "数量与价格必须为正数"})
                return
            positions = _load_positions()
            rec = next((p for p in positions if p.get("code") == code), None)
            if side == "buy":
                if rec is None:
                    name = item.get("name", "") or ""
                    if not name:
                        try:
                            name = (ds.fetch_realtime([code]).get(code) or {}).get("name", "") or code
                        except Exception:
                            name = code
                    rec = {"code": code, "name": name, "shares": 0, "cost": 0.0}
                    positions.append(rec)
                old = int(rec.get("shares", 0) or 0)
                oldcost = float(rec.get("cost", 0) or 0)
                new = old + qty
                rec["cost"] = round((oldcost * old + price * qty) / new, 4) if new > 0 else 0.0
                rec["shares"] = new
                rec["name"] = item.get("name") or rec.get("name") or code
            else:
                if rec is None:
                    self._send(400, {"error": "未持有该股票，无法卖出"})
                    return
                old = int(rec.get("shares", 0) or 0)
                if qty > old:
                    self._send(400, {"error": f"卖出数量 {qty} 超过持仓 {old}"})
                    return
                rec["shares"] = old - qty
                if rec["shares"] <= 0:
                    positions = [p for p in positions if p.get("code") != code]
            # 现金随交易变动（买入减、卖出加）
            acct = _load_account()
            if side == "buy":
                acct["cash"] = round(float(acct.get("cash", 0) or 0) - price * qty, 2)
            else:
                acct["cash"] = round(float(acct.get("cash", 0) or 0) + price * qty, 2)
            _sync_account(acct)
            _save_json(POSITIONS, positions)
            try:
                _save_json(STATIC_POSITIONS, positions)
            except Exception as e:
                print("[WARN] static positions write failed (cloud may be read-only):", e)
            self._send(200, {"ok": True, "cash": acct["cash"], "positions": positions})
            return
        if route == "/api/account":
            # 持仓截图同步：由 AI 解析图片后调用，整体覆盖现金 + 持仓，
            # 并把"当日基准"重置为当前快照（截图即当日初始真相）。
            item = payload if isinstance(payload, dict) else {}
            positions_in = item.get("positions")
            if not isinstance(positions_in, list):
                self._send(400, {"error": "positions 必填且为数组"})
                return
            norm = []
            for p in positions_in:
                if not isinstance(p, dict) or not p.get("code"):
                    continue
                try:
                    norm.append({
                        "code": str(p["code"]).strip().lower(),
                        "name": p.get("name", ""),
                        "shares": int(p.get("shares", 0) or 0),
                        "cost": float(p.get("cost", 0) or 0),
                    })
                except (TypeError, ValueError):
                    continue
            _save_json(POSITIONS, norm)
            try:
                _save_json(STATIC_POSITIONS, norm)
            except Exception as e:
                print("[WARN] static positions write failed (cloud may be read-only):", e)
            acct = _load_account()
            if item.get("cash") is not None:
                try:
                    acct["cash"] = float(item["cash"])
                except (TypeError, ValueError):
                    pass
            today = _today_str()
            acct["baseline_date"] = today
            acct["baseline_cash"] = acct["cash"]
            acct["baseline_shares"] = {p["code"]: p["shares"] for p in norm}
            _sync_account(acct)
            self._send(200, {"ok": True, "cash": acct["cash"], "positions": norm})
            return
        if route == "/api/alerts":
            alerts = _load_json(ALERTS, [])
            item = {
                "id": int(time.time() * 1000),
                "code": payload.get("code", ""),
                "name": payload.get("name", ""),
                "type": payload.get("type", "price"),
                "op": payload.get("op", "above"),
                "value": payload.get("value"),
                "action": payload.get("action"),
                "created": time.strftime("%Y-%m-%d %H:%M:%S"),
            }
            alerts.append(item)
            _save_json(ALERTS, alerts)
            self._send(200, {"ok": True, "alert": item})
            return
        if route == "/api/review/capture":
            rec = payload if isinstance(payload, dict) else {}
            try:
                _capture_review(rec)
                self._send(200, {"ok": True})
            except Exception as e:
                self._send(200, {"ok": False, "error": str(e)})
            return
        self._send(404, {"error": "unknown route"})

    def do_DELETE(self):
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)
        if parsed.path == "/api/alerts":
            aid = qs.get("id", [""])[0]
            alerts = _load_json(ALERTS, [])
            alerts = [a for a in alerts if str(a.get("id")) != aid]
            _save_json(ALERTS, alerts)
            self._send(200, {"ok": True, "remaining": len(alerts)})
            return
        if parsed.path == "/api/positions":
            code = qs.get("code", [""])[0]
            positions = _load_positions()
            positions = [p for p in positions if p.get("code") != code]
            # 双写：runtime + 主源（云端 read-only 时自动跳过主源）
            _save_json(POSITIONS, positions)
            try:
                _save_json(STATIC_POSITIONS, positions)
            except Exception as e:
                print("[WARN] static positions delete sync failed:", e)
            self._send(200, {"ok": True, "remaining": len(positions)})
            return
        self._send(404, {"error": "unknown route"})

    def _static(self, rel):
        full = os.path.normpath(os.path.join(BASE, "static", rel))
        if not full.startswith(os.path.join(BASE, "static")):
            self._send(403, {"error": "forbidden"})
            return
        ctype = "text/css; charset=utf-8" if rel.endswith(".css") else \
            "application/javascript; charset=utf-8" if rel.endswith(".js") else \
            "image/svg+xml" if rel.endswith(".svg") else "application/octet-stream"
        self._send_file(full, ctype)

    def _analyze_one(self, code, limit, pred, names, capital=None):
        """对单只股票打分并判断是否命中策略；异常或不足则返回 None。"""
        try:
            bars = ds.get_kline(code, "daily", limit, _tdx_path or None)
            if len(bars) < 60:
                return None
            flags = sig.scan_flags(bars)
            if not flags:
                return None
            if not pred(flags):
                return None
            a = sig.analyze(bars, _WEIGHTS)
            if not a.get("ok"):
                return None
            price = a.get("price")
            pl = a.get("price_levels") or {}
            try:
                bars5m = _cache_get(code, "5m", 60) or ds.get_kline(code, "5m", 60, _tdx_path or None)
                _cache_set(code, "5m", 60, bars5m)
            except Exception:
                bars5m = None
            cl = sig.candidate_levels(bars5m, bars, a.get("prev_close"))
            buy_price = cl["buy"] if cl else (round(price * 0.97, 2) if price else None)
            sell_price = cl["sell"] if cl else (round(price * 1.06, 2) if price else None)
            cap = capital if capital else _config.get("available_capital", 100000)
            lot = _POS.get("lot", 100)
            qty = max(int(cap / buy_price // lot) * lot, 0) if (buy_price and buy_price > 0) else 0
            return {
                "code": code,
                "name": names.get(code, ""),
                "action": a["action"],
                "score": a["score"],
                "price": price,
                "buy_price": buy_price,
                "sell_price": sell_price,
                "buy_qty": qty,
                "flags": {k: v for k, v in flags.items() if k not in ("score", "action")},
                "reasons": [r["text"] for r in a["reasons"][:3]],
            }
        except Exception:
            return None

    def _attach_news(self, results, score_key="combined", topn=30):
        """best-effort 给前 topn 只补新闻因子（情绪分微调综合/评分），失败不报错。"""
        if not results:
            return results
        top = results[:topn]

        def _fetch(r):
            try:
                nw_d = nw.stock_news(r.get("code"))
                if nw_d.get("status") == "ok" and nw_d.get("headlines"):
                    s = nw.news_sentiment(nw_d["headlines"])
                    r["news"] = {"status": "ok", "score": s, "headlines": nw_d["headlines"][:3]}
                    base = r.get(score_key, 0) or 0
                    r[score_key] = round(base * 0.9 + (s + 100) / 2 * 0.1, 1)
                else:
                    r["news"] = {"status": nw_d.get("status", "unavailable"), "headlines": []}
            except Exception:
                r["news"] = {"status": "unavailable", "headlines": []}

        try:
            with ThreadPoolExecutor(max_workers=10) as ex:
                list(ex.map(_fetch, top))
        except Exception:
            pass
        results.sort(key=lambda x: x.get(score_key, 0) or 0, reverse=True)
        return results

    def _run_screener(self, codes, limit, strategy="composite"):
        """同步选股（用于自选/小池）。"""
        results = []
        names = {}
        cap = _config.get("available_capital", 100000)
        for chunk in _chunk(codes, 80):
            try:
                rt = ds.fetch_realtime(chunk)
                for c, v in rt.items():
                    names[c] = v.get("name", "")
            except Exception:
                pass
        pred = sig.STRATEGY_PREDICATES.get(strategy, sig.STRATEGY_PREDICATES["composite"])
        for code in codes:
            r = self._analyze_one(code, limit, pred, names, capital=cap)
            if r:
                results.append(r)
        # 排序：动作优先级(强买>买入>持有>减仓>卖出) 优先，同档按评分降序
        results.sort(key=_action_sort_key)
        self._attach_news(results, "score", 20)
        return results

    def _run_candidate_screener(self, codes, limit, capital, strategy="composite", progress_cb=None):
        """候选股扫描（十五五成长池）：多因子利益最大化模型。

        因子（动态主导，合计 100%）：
          技术面 30% + 行业轮动 28% + 估值(PE+质量档) 27% + 个股动量 15%
        - 行业轮动 = 赛道实时强弱(腾讯实时涨跌幅均值) + 赛道20日动量(成分股)，每日动态 → 板块轮动即反映
        - 估值 = 腾讯实时 PE 曲线 + 质量档微调（PE 本地可达，解决旧版拉不到导致静态的问题）
        - 新闻/机构目标价 best-effort（云端 Render 通，本地降级为中性，不计入主权重）
        """
        results = []
        lot = _POS.get("lot", 100)
        # 1) 批量腾讯实时行情：PE / 涨跌幅 / 市值（本地可达，关键修复点）
        try:
            rt_all = ds.fetch_realtime(codes)
        except Exception:
            rt_all = {}
        # 2) 东财实时估值（best-effort，云端通；本地降级，仅作 PB 补充）
        valuations = {}
        vt = threading.Thread(target=lambda: valuations.update((fm.batch_valuation(codes) or {})),
                              daemon=True)
        vt.start()

        def _worker(code):
            try:
                bars = ds.get_kline(code, "daily", limit, _tdx_path or None)
                if len(bars) < 60:
                    return None
                a = sig.analyze(bars, _WEIGHTS)
                if not a.get("ok"):
                    return None
                price = a.get("price")
                rt = rt_all.get(code) or {}
                pe = rt.get("pe") if rt else None
                fp = ip.get_fund(code) or {}
                track = fp.get("track")
                sector = fp.get("sector")
                grade = fp.get("grade", "B")
                note = fp.get("note", "")
                tech = max(0.0, min(100.0, (a["score"] + 100) / 2))   # 技术面 0-100
                # 多因子
                f = sc.compute_factors(code, bars, rt, fp,
                                       (sf.sector_strength(track) if track else None))
                val = f["val_score"]
                mom = f["mom_score"]
                sector_score = f["sector_score"]
                mom_ret = f["_mom_ret"]
                combined = round(tech * sc.W_TECH + sector_score * sc.W_SECTOR
                                 + val * sc.W_VAL + mom * sc.W_MOM, 1)
                # 买/卖价（沿用分位 + MA20/MA5）
                try:
                    bars5m = _cache_get(code, "5m", 60) or ds.get_kline(code, "5m", 60, _tdx_path or None)
                    _cache_set(code, "5m", 60, bars5m)
                except Exception:
                    bars5m = None
                cl = sig.candidate_levels(bars5m, bars, a.get("prev_close"))
                buy_price = cl["buy"] if cl else (round(price * 0.97, 2) if price else None)
                sell_price = cl["sell"] if cl else (round(price * 1.06, 2) if price else None)
                act = sc.action_for(combined, mom_ret, tech)
                qty = 0
                if buy_price and buy_price > 0:
                    q = int(capital / buy_price // lot) * lot
                    qty = max(q, 0)
                return {
                    "code": code,
                    "name": fp.get("name") or code,
                    "track": track or "",
                    "action": act,
                    "tech_score": round(tech, 1),
                    "val_score": val,
                    "mom_score": mom,
                    "fund_grade": grade,
                    "sector_score": sector_score,
                    "pe": pe,
                    "pb": (valuations.get(code) or {}).get("pb"),
                    "target": None, "target_upside": None, "expect_score": None,
                    "news_score": 50,
                    "combined": combined,
                    "price": price,
                    "change_pct": (rt.get("change_pct") if rt else None),
                    "buy_price": buy_price,
                    "sell_price": sell_price,
                    "ma5": cl["ma5"] if cl else None,
                    "ma20": cl["ma20"] if cl else None,
                    "vs_ma20_pct": cl["vs_ma20_pct"] if cl else None,
                    "trend_hint": cl["trend"] if cl else None,
                    "today_high": cl["today_high"] if cl else None,
                    "today_low": cl["today_low"] if cl else None,
                    "buy_qty": qty,
                    "capital": capital,
                    "sector": sector,
                    "sector_trend": f["sector_trend"],
                    "sector_fund": f["sector_fund"],
                    "up_ratio": f["up_ratio"],
                    "note": note,
                    "reasons": [r["text"] for r in a["reasons"][:2]],
                    "_mom_ret": mom_ret,
                }
            except Exception:
                return None

        with ThreadPoolExecutor(max_workers=20) as ex:
            futs = [ex.submit(_worker, c) for c in codes]
            for fut in as_completed(futs):
                try:
                    r = fut.result()
                except Exception:
                    r = None
                if r:
                    results.append(r)
                if progress_cb:
                    progress_cb()
        vt.join(timeout=8)  # 尽量等估值回写，超时不影响（估值按 PE/质量档兜底）
        # 行业轮动：叠加「赛道20日动量」，让板块轮动每日动态变化
        sc.apply_sector_momentum(results)
        # 预期发展（机构目标价/PE，best-effort，云端通）
        self._enrich_expect(results, topn=40)
        # 新闻因子（个股 + 行业，best-effort，云端通）
        self._attach_news(results, "combined", 30)
        self._attach_industry_news(results)
        # 最终排序：动作优先级(强买>买入>持有>减仓>卖出) 优先，同档按综合分降序
        results.sort(key=_action_sort_key)
        return results

    def _enrich_expect(self, results, topn=40):
        """给头部候选补机构目标价/PE，算「预期发展」分并小幅加成综合分。best-effort（云端通）。

        注意：综合分主体由多因子模型（技术/行业/估值/动量）决定，这里只做「预期加成」，
        不重写综合分，避免覆盖动态因子。
        """
        top = results[:topn]

        def _tgt(r):
            try:
                t = fm.fetch_target_price(r.get("code"))
                if t and r.get("price"):
                    r["target"] = t
                    r["target_upside"] = round(t / r["price"] - 1, 4)
                else:
                    r["target"] = None
                    r["target_upside"] = None
            except Exception:
                r["target"], r["target_upside"] = None, None

        try:
            with ThreadPoolExecutor(max_workers=8) as ex:
                list(ex.map(_tgt, top))
        except Exception:
            pass
        for r in top:
            pe = r.get("pe")
            tup = r.get("target_upside")
            ns = (r.get("news") or {}).get("score", 0) if r.get("news") else 0
            grade = r.get("fund_grade", "B")
            exp = fm.expectation_score(pe=pe, target_upside=tup, news_score=ns, grade=grade)
            r["expect_score"] = round(exp, 1)
            # 机构目标价上行空间 → 小幅加成（利益最大化：有上行空间更优）
            bonus = 0.0
            if tup is not None:
                bonus = max(-4.0, min(4.0, tup * 100 * 0.25))
            base = r.get("combined", 50.0) or 50.0
            r["combined"] = round(base + bonus, 1)
        return results

    def _attach_industry_news(self, results, topn=60):
        """行业新闻因子（best-effort）：按 sector 聚合东财快讯情绪，给同赛道候选小幅加成。

        仅对头部 + 代表性赛道生效；任何失败静默降级（本地网络受限时不影响扫描）。
        """
        if not results:
            return results
        # 取结果中出现的 sector，逐个算行业新闻情绪（缓存避免重复拉取）
        sectors = []
        for r in results[:topn]:
            s = r.get("sector")
            if s and s not in sectors:
                sectors.append(s)
        sent = {}
        for s in sectors:
            try:
                d = nw.industry_news(s)
                sent[s] = d
            except Exception:
                sent[s] = {"status": "unavailable", "score": 0, "headlines": []}
        for r in results[:topn]:
            s = r.get("sector")
            d = sent.get(s) or {"score": 0, "headlines": []}
            sc_score = d.get("score", 0) or 0   # -100..100
            r["industry_news"] = {"status": d.get("status", "unavailable"),
                                  "score": sc_score,
                                  "headlines": d.get("headlines", [])[:2]}
            if sc_score:
                base = r.get("combined", 50.0) or 50.0
                # 行业新闻占综合分约 7%：combined = base*0.93 + (sc/100*50+50)*0.07
                boost = (sc_score / 100.0 * 50.0 + 50.0)
                r["combined"] = round(base * 0.93 + boost * 0.07, 1)
        results.sort(key=lambda x: x.get("combined", 0), reverse=True)
        return results

    def _run_candidate_bg(self, codes, limit, cap, strategy):
        """候选扫描后台线程：结果写入全局 _scan，前端轮询 /api/scan_status。"""
        try:
            _scan["total"] = len(codes)
            _scan["done"] = 0
            _scan["results"] = []
            _scan["error"] = None
            _scan["scope"] = "candidate"
            _scan["strategy"] = strategy
            result = self._run_candidate_screener(
                codes, limit, cap, strategy,
                progress_cb=lambda: _scan.__setitem__("done", _scan.get("done", 0) + 1))
            _scan["results"] = result
        except Exception as e:
            _scan["error"] = str(e)
        finally:
            _scan["running"] = False

    def _scan_all_worker(self, codes, limit, strategy):
        """后台全市场扫描：并发打分 + 进度回写，结果写入全局 _scan。"""
        global _scan
        try:
            pred = sig.STRATEGY_PREDICATES.get(strategy, sig.STRATEGY_PREDICATES["composite"])
            _scan["total"] = len(codes)
            _scan["done"] = 0
            names = {}
            for chunk in _chunk(codes, 80):
                try:
                    rt = ds.fetch_realtime(chunk)
                    for c, v in rt.items():
                        names[c] = v.get("name", "")
                except Exception:
                    pass
            results = []
            _lock = threading.Lock()

            def work(code):
                r = self._analyze_one(code, limit, pred, names)
                with _lock:
                    if r:
                        results.append(r)
                    _scan["done"] += 1

            from concurrent.futures import ThreadPoolExecutor
            with ThreadPoolExecutor(max_workers=12) as ex:
                list(ex.map(work, codes))
            results.sort(key=lambda x: x["score"], reverse=True)
            _scan["results"] = results
        except Exception as e:
            _scan["error"] = str(e)
        finally:
            _scan["running"] = False

    def _check_alerts(self):
        alerts = _load_json(ALERTS, [])
        if not alerts:
            return []
        codes = list({a["code"] for a in alerts if a.get("code")})
        try:
            rt = ds.fetch_realtime(codes)
        except Exception:
            return []
        triggered = []
        for a in alerts:
            q = rt.get(a["code"])
            if not q:
                continue
            price = q.get("price")
            if a.get("type") == "price" and price is not None and a.get("value") is not None:
                v = float(a["value"])
                if a.get("op") == "above" and price >= v:
                    triggered.append({**a, "now": price})
                elif a.get("op") == "below" and price <= v:
                    triggered.append({**a, "now": price})
            elif a.get("type") == "signal":
                try:
                    bars = ds.get_kline(a["code"], "daily", 120, _tdx_path or None)
                    an = sig.analyze(bars)
                    if an.get("ok") and an["action"] == a.get("action"):
                        triggered.append({**a, "now": an["score"]})
                except Exception:
                    continue
        return triggered


def main():
    port = int(os.environ.get("PORT", "8723"))
    # 绑定 0.0.0.0 以便同一局域网内手机/其他设备访问（公网暴露请务必加反代与鉴权）
    srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"婷婷量化AI 已启动： http://127.0.0.1:{port}")
    try:
        import socket
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        lan_ip = s.getsockname()[0]
        s.close()
        print(f"手机/局域网访问： http://{lan_ip}:{port}   （手机需连同一 WiFi）")
    except Exception:
        pass
    print(f"通达信数据源： {'已启用 ' + _tdx_path if _tdx_available else '未配置（使用在线行情）'}")
    # 后台预生成全 A 股代码池，使首次「在线全市场」扫描即时可用
    threading.Thread(target=_get_universe, daemon=True).start()

    # 服务端后台调度：自动生成开盘判断 + 四时点快照 + 收盘复盘（不依赖浏览器是否打开）
    # 交易时段(9:00-15:10)每分钟检查一次；其余时间 5 分钟一次，省资源
    def _daily_scheduler():
        while True:
            try:
                run_daily("auto")
            except Exception:
                pass
            h, m = time.localtime().tm_hour, time.localtime().tm_min
            if 9 <= h < 15 or (h == 15 and m <= 10):
                time.sleep(60)
            else:
                time.sleep(300)
    threading.Thread(target=_daily_scheduler, daemon=True).start()

    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.shutdown()


if __name__ == "__main__":
    main()
