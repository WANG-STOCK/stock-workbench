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
from core.indicators import compute_all, sma, macd
from core import industry_pool as ip
from core import fundamentals as fm
from core import sector_flow as sf
from core import news as nw
from core import screener as sc
from core import strategies as strat
from core import backtest as bt
from core import intraday as intraday_mod
from core import daily_strategy as dsmod
from core.daily_strategy import run_daily, open_judgment, generate_snapshot, generate_review
from core import market_sentiment as msent

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
# 今日成交明细：所有 trade 操作都附加写一份日志（含时间/价格/数量），前端可查今日已买/卖清单
TRADE_LOG = os.path.join(DATA_DIR, "trade_log.json")
# 公开云端主源（git 跟踪），重启/部署后能恢复
STATIC_TRADE_LOG = os.path.join(BASE, "static", "trade_log.json")

os.makedirs(DATA_DIR, exist_ok=True)


def _ensure_dir(d):
    """兼容旧调用：空操作（os.makedirs(..., exist_ok=True) 已在外层处理）。"""
    try:
        os.makedirs(d, exist_ok=True)
    except Exception:
        pass


# ---------- 配置 ----------
_config = {"tdx_path": "", "kline_ttl": {"1m": 15, "5m": 30, "15m": 60, "30m": 120, "60m": 300,
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


# ---------- r38 通用结果缓存（按 key 缓存任意 JSON 值，TTL 到期自动失效） ----------
_strategy_cache = {}      # key=(code,mode) -> (ts, value)
_screener_cache = {}      # key=(scope,strategy,limit) -> (ts, value)
_signal_cache   = {}      # key=(code,period,limit) -> (ts, value)
_strategy_lock  = threading.Lock()
_screener_lock  = threading.Lock()
_signal_lock    = threading.Lock()


def _json_cache_get(store, lock, key, ttl):
    with lock:
        v = store.get(key)
        if v:
            ts, val = v
            if time.time() - ts < ttl:
                return val
    return None


def _json_cache_set(store, lock, key, val):
    with lock:
        store[key] = (time.time(), val)


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
_FACTS_PENDING = set()
_FACTS_LOCK = threading.Lock()


def _stock_facts(code, ttl=300):
    """返回 {pe, pb, target, target_upside, news_score}；任何缺失均 None。

    非阻塞：缓存命中直接返回；未命中时立即返回 None（不阻塞请求），
    并在后台线程异步补抓，下一次刷新（5s）即拿到真实基本面。
    避免首屏因 5 只持仓 × 3 次网页抓取（估值/目标价/新闻）卡 20~30s。
    """
    now = time.time()
    with _FACTS_LOCK:
        c = _FACTS_CACHE.get(code)
        if c and now - c[0] < ttl:
            return c[1]
        if code not in _FACTS_PENDING:   # 防止并发重复触发后台抓取
            _FACTS_PENDING.add(code)
            threading.Thread(target=_fetch_facts_bg, args=(code,), daemon=True).start()
    return None


def _fetch_facts_bg(code):
    """后台补抓单只个股基本面并写入缓存。"""
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
    finally:
        with _FACTS_LOCK:
            _FACTS_CACHE[code] = (time.time(), facts)
            _FACTS_PENDING.discard(code)


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


def _position_cost(code):
    """返回该持仓股的成本价（无持仓则返回 None）。"""
    try:
        for p in _load_positions():
            if p.get("code") == code:
                c = p.get("cost")
                if c is not None:
                    try:
                        return float(c)
                    except (TypeError, ValueError):
                        return None
    except Exception:
        pass
    return None


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


def _build_forecast(a, regime, outlook, prev_close, action, intraday=None, tl=None):
    """今日预估：综合开盘/集合竞价/板块涨跌/资金净流/MACD+KDJ+量能短线信号，给 (trend, pct, basis[], forecast_high, forecast_low)。

    forecast_high/low —— 整天预估最高/最低，用于"卖在最高附近、买在最低附近"。
    r16 改动：去掉 MA5/MA10/MA20 basis（持仓只看短线最及时技术面，MA 用于自选筛股）。
    basis 改为：集合竞价 + 板块 + MACD(K线零轴) + KDJ(J值拐头) + 量能(异动) + 短线综合。
    """
    ind = (a or {}).get("indicators") or {}
    macd = ind.get("macd") or {}
    kdj = ind.get("kdj") or {}
    vol = ind.get("vol") or {}
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
                pct += tpct * 0.4
        if fn is not None:
            if fn >= 2:
                # r16: 资金净流入在板块块显示，今日预估不再列（避免重复）
                pct += 0.8
            elif fn <= -2:
                pct -= 0.8
    # 3) MACD 短线方向（r16：去掉 MA 系列，强化 MACD 零轴信号 = 中线趋势确认）
    dif = macd.get("dif"); dea = macd.get("dea"); hist = macd.get("hist")
    if dif is not None and dea is not None:
        if dif > dea and dif > 0 and (hist is None or hist > 0):
            basis.append("MACD 零轴上金叉·中线偏多")
            pct += 0.7
        elif dif > dea and dif < 0:
            basis.append("MACD 零轴下金叉·反弹启动")
            pct += 0.4
        elif dif < dea and dif > 0:
            basis.append("MACD 零轴上死叉·警惕回调")
            pct -= 0.5
        elif dif < dea and dif < 0 and (hist is None or hist < 0):
            basis.append("MACD 零轴下死叉·趋势走弱")
            pct -= 0.9
        elif dif > dea:
            basis.append("MACD 金叉·红柱")
            pct += 0.4
        elif dif < dea:
            basis.append("MACD 死叉·绿柱")
            pct -= 0.4
    # 4) KDJ 短线拐点（r16：补 J 值/拐头，最及时的短线判断）
    k_v = kdj.get("k"); d_v = kdj.get("d"); j_v = kdj.get("j")
    j_turn_up = kdj.get("turn_up")
    j_turn_down = kdj.get("turn_down")
    kdj_overbought = kdj.get("overbought")
    kdj_oversold = kdj.get("oversold")
    if k_v is not None and d_v is not None and j_v is not None:
        if j_v > 100:
            basis.append(f"KDJ J={j_v:.0f} 极度超买·准备减仓")
            pct -= 0.9
        elif j_v < 0:
            basis.append(f"KDJ J={j_v:.0f} 极度超卖·准备低吸")
            pct += 0.9
        elif kdj_overbought or (j_turn_down and j_v > 60):
            basis.append(f"KDJ 拐头向下·短线警惕(J={j_v:.0f})")
            pct -= 0.6
        elif kdj_oversold or (j_turn_up and j_v < 40):
            basis.append(f"KDJ 拐头向上·短线买入(J={j_v:.0f})")
            pct += 0.6
        elif k_v > d_v and j_v > kdj.get("j_prev", j_v):
            basis.append(f"KDJ K上穿D·金叉(K={k_v:.0f},D={d_v:.0f})")
            pct += 0.4
        elif k_v < d_v and j_v < kdj.get("j_prev", j_v):
            basis.append(f"KDJ K下穿D·死叉(K={k_v:.0f},D={d_v:.0f})")
            pct -= 0.4
    # 5) 量能（r16：补"量比"信号，突破/缩量共振）
    vol_ratio = vol.get("ratio")
    if vol_ratio is not None:
        if vol_ratio >= 1.5:
            basis.append(f"量比 {vol_ratio:.2f} 放量异动")
            # 量能方向配合 MACD/KDJ（已经在上面的 basis 给出方向）
        elif vol_ratio <= 0.6:
            basis.append(f"量比 {vol_ratio:.2f} 缩量观望")
    # 定性：把 pct 映射到 trend
    if pct >= 0.8:
        trend = "偏多"
    elif pct <= -0.8:
        trend = "偏空"
    else:
        trend = "震荡"
    if outlook and outlook.get("trend"):
        trend = outlook["trend"]   # 以 sig.day_outlook 的定性为准（已综合技术+资金）

    # 利润最大化：整天预估最高/最低（卖给最高、买给最低）
    forecast_high = forecast_low = None
    pct_band = max(2.5, abs(pct) * 0.7)  # 预估价区间，保守 2.5%
    day_high = (intraday or {}).get("high")
    day_low = (intraday or {}).get("low")
    support = (tl or {}).get("buy")
    resist = (tl or {}).get("sell")
    if price and price > 0:
        ups = []
        if day_high and day_high > 0:
            ups.append(round(day_high * 1.005, 2))
        ups.append(round(price * (1 + pct_band / 100), 2))
        if resist and resist > 0 and abs(resist - price) / price <= 0.05:
            ups.append(round(resist * 1.005, 2))
        forecast_high = max(ups) if ups else round(price * (1 + pct_band / 100), 2)
        # 上限：防极端
        forecast_high = min(forecast_high, round(price * 1.12, 2))

        lows = []
        if day_low and day_low > 0:
            lows.append(round(day_low * 0.995, 2))
        lows.append(round(price * (1 - pct_band / 100), 2))
        if support and support > 0 and abs(support - price) / price <= 0.05:
            lows.append(round(support * 0.995, 2))
        forecast_low = min(lows) if lows else round(price * (1 - pct_band / 100), 2)
        # 下限：防极端
        forecast_low = max(forecast_low, round(price * 0.88, 2))

    return {
        "trend": trend,
        "pct": round(pct, 2),
        "basis": basis[:6],         # 最多 6 条
        "forecast_high": forecast_high,
        "forecast_low": forecast_low,
        "pct_band": round(pct_band, 2),
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


def _advise_position(code, capital, rt_price=None, rt_prev=None):
    """为单只持仓计算完整操作建议：买/卖/不动 + 操作价 + 操作量 + 行业强弱。

    综合：当天 KDJ/量/资金/MACD 等技术面 + 行业资金流入流出与龙头走势
    （sector_strength）+ 用户可用资金/持仓（position_advice 算量）。
    返回 dict；K线不足时返回 {ok:False}。
    rt_price / rt_prev：调用方（持仓建议接口）传入的实时价/昨收，
    若提供则全程以实时价作为"当前价"，保证操作建议/紧凑买卖价贴合实时行情。
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
    # 若调用方传入实时价/昨收，则全程以实时价作为"当前价"（建议应反映实时行情，
    # 否则 tight/intraday 会基于日线收盘价算出偏离实际现价 5%+ 的买卖价）。
    if rt_price is not None:
        price = rt_price
    if rt_prev is not None:
        prev_close = rt_prev
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
    # 盘中实时建议（5min 分时级别，看一眼该买/卖/等的瞬时判断）—— 先算，供下方 action 收敛使用
    intraday = _intraday_for(code, price, prev_close)
    # 收敛为 买/卖/不动
    if adp.get("bias") == "defensive":
        action = "卖出"
    elif outlook and outlook.get("action") == "买":
        action = "买入"
    elif outlook and outlook.get("action") == "卖":
        action = "卖出"
    else:
        action = "不动"
    # 盘中强势反转（早盘下杀→午后拉起）：明确的盘中看多信号，绝不"卖出"。
    # 王总反馈：太极这种"早上低点→现在涨很多"的强反转日，不该给"卖出"，应加仓看多。
    _intra_sc = (intraday or {}).get("scenario")
    if _intra_sc == "探底回升·强势多头":
        # intraday 模块自身对该场景给"持有看多/可回踩加仓"，统一收敛为"买入"（加仓），
        # 覆盖日线/防御模型可能给出的"卖出"——强反转日卖出等于卖飞。
        action = "买入"
    # ===== r16 持仓短线 override：KDJ + MACD + 量能 1-3 天拐点 =====
    # 王总原话："我持仓的你只需要参考 MACD 和 KDJ 还有量能这些，我需要最及时的技术面"
    # MA5/MA20 只用于自选筛股；持仓决策让位于 intraday 5min KDJ(超买超卖/J拐头)+MACD(红绿柱)+量比
    # 只在两种情况覆盖：(1) action 原本要"买入"但 KDJ 极度超买/死叉拐头 → 卖出 (2) action 原本要"卖出"但 KDJ 极度超卖/金叉上拐 + 量比>1 → 买入
    # 这样保证最不利情况下也不让"加仓到顶"或"割在最低"
    _tm = (intraday or {}).get("metrics") or {}
    _kj = _tm.get("kdj_j")
    _ks = _tm.get("kdj_status")
    _kt = _tm.get("kdj_turn")
    _mr = _tm.get("macd_status")
    _vr = _tm.get("vol_ratio")
    # override condition 1: 极度超买 + 死叉拐头 + 高位→强制卖出（哪怕之前是买入也得停）
    if action == "买入" and _kj is not None:
        if _kj > 100 or (_ks == "超买" and _kt == "下拐" and _vr and _vr >= 1.3):
            action = "卖出"
            reason_override = f"⚠️ KDJ J={_kj:.0f}超买+拐头向下，止盈卖出避免高位回调"
        elif _kj > 95 and _mr == "红柱缩":
            action = "卖出"
            reason_override = f"⚠️ KDJ J={_kj:.0f}超买+MACD红柱缩短，分批止盈"
    # override condition 2: 极度超卖 + 金叉上拐 + 放量→强制买入（哪怕之前要"卖出"也得拉回）
    if action == "卖出" and _kj is not None:
        if _kj < 0 or (_ks == "超卖" and _kt == "上拐" and _vr and _vr >= 1.3):
            action = "买入"
            reason_override = f"⚠️ KDJ J={_kj:.0f}超卖+拐头向上+放量，抢反弹"
        elif _kj < 10 and _mr == "绿柱" and _vr and _vr >= 1.5:
            action = "买入"
            reason_override = f"⚠️ KDJ J={_kj:.0f}极度超卖+放量，跌不动了"
    # 操作价：买用当日买点/支撑，卖用当日卖点/阻力 —— 价格必须约束在当前价 ±3% 内，
    # 否则当天到不了那个价。建议卖出/买入是"现在/明天可执行"的动作，不是看天价。
    pl = a.get("price_levels") or {}
    if action == "买入":
        op_price = (tl or {}).get("buy") or pl.get("buy")
    elif action == "卖出":
        op_price = (tl or {}).get("sell") or pl.get("sell")
    else:
        op_price = None
    # 操作价放宽：旧版 ±3% 截断在强势日让用户"卖飞/买陡"。
    # 新版：用 forecast_high（卖→给高位）+ forecast_low（买→给低位），不再钉死在 ±3% 内；
    # 同时 forecast_high/low 已在 _build_forecast 钳制到 ±12%，不会突破涨停。
    forecast = _build_forecast(a, regime, outlook, prev_close, action, intraday=intraday, tl=tl)
    fc_hi = forecast.get("forecast_high")
    fc_lo = forecast.get("forecast_low")
    if op_price and price:
        if action == "卖出":
            # 允许操作价 ≤ forecast_high（甚至更高 0.5%）—— 保证"卖在最高附近"
            hi_cap = max(price * 1.005, (fc_hi or price * 1.03) * 0.998)
            if op_price > price * 1.005 and op_price < (fc_hi or op_price):
                pass  # 高位价 + 不超 forecast_high → 接受
            op_price = min(op_price, round(hi_cap, 2))
        elif action == "买入":
            # 允许操作价 ≥ forecast_low（甚至更低 0.5%）—— 保证"买在最低附近"
            lo_cap = min(price * 0.995, (fc_lo or price * 0.97) * 1.002)
            if op_price < price * 0.995 and op_price > (fc_lo or op_price):
                pass
            op_price = max(op_price, round(lo_cap, 2))
    # 操作量：买=加仓股数，卖=减仓股数（不超持仓），不动=0
    delta = int(pos.get("delta_shares") or 0)
    if action == "买入":
        # 强势反转日（探底回升）默认回踩加仓 1 手（_POS.lot）；若仓位模型本身建议更多则取较大者。
        # 注意：必须保证 op_qty 至少为 1 手，否则下方会被重置成"不动"，强反转buy信号失效。
        _lot = _POS.get("lot", 100)
        op_qty = max(_lot, delta) if delta > 0 else _lot
    elif action == "卖出":
        op_qty = min(max(0, -delta), held)
    else:
        op_qty = 0
    if action in ("买入", "卖出") and op_qty <= 0:
        action, op_qty = "不动", 0
    # 实时动态价位（贴在现价 ±0.8% 的紧凑区间，替代原本宽达 ±3% 的做T价）
    # 既保留 dynamic_levels 的支撑/阻力参考，又贴现价给出"立刻能挂的限价"。
    tight = _tight_levels(price, intraday, tl)
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
    # ===== 今日预估（涨/跌/震荡 + pct + 依据 + 利润最大化的 forecast_high/low）=====
    # 注意：forecast 已在 op_price 收敛阶段提前算过（带 intraday+tl）—— 这里直接复用
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
        "reason_override": reason_override if "reason_override" in dir() else None,
        "regime": regime,
        "industry_today": industry_today,
        "indicators": a.get("indicators"),
        "intraday": intraday,
        "tight": tight,                       # 紧凑买卖价（贴在现价附近 ±0.8%）
        "forecast": forecast,
        "sector_detail": sector_detail,
        "technical": technical,
        # r16 短线技术面速读（持仓只看 MACD+KDJ+量能）
        "tech_short": {
            "kdj_j": _kj,
            "kdj_status": _ks,
            "kdj_turn": _kt,
            "macd_status": _mr,
            "vol_ratio": _vr,
            "rsi": _tm.get("rsi"),
            "boll_pos": _tm.get("boll_pos"),
        } if intraday else None,
    }


# 实时买/卖/止损/止盈：ATR/分时波动驱动 + "利润最大化"spread
# —— 旧版固定 ±0.8% 太窄，强反转日会让用户"卖飞/买陡"；改为跟实盘波动走。
# 核心：
#   1) band 至少 2.5%（最小利润空间）
#   2) 实时扩张：当日已实现 high-low 跨度的 70%（覆盖日内波动 → 卖在最高附近、买在最低附近）
#   3) intaday 已给出 target_price/stop_loss → 优先吸附到该价位
#   4) dynamic_levels 给出的支撑/阻力 → 在 ±5% 范围内吸附
#   5) 反向钳制：buy 不能低于当日 low×0.995、sell 不能高于当日 high×1.005（避免"橡皮筋价"）
def _tight_levels(price, intraday, tl):
    if not price:
        return None

    # 1) 计算 band_pct（实时动态）
    band_pct = 0.025  # 下限：±2.5%
    day_high = (intraday or {}).get("high")
    day_low = (intraday or {}).get("low")
    if day_high and day_low and day_high > day_low and price > 0:
        day_band = (day_high - day_low) / price
        # 让 band 至少覆盖日内波幅的 70%——给利润最大化留空间
        band_pct = max(band_pct, day_band * 0.7)
    # 防极端：单日波幅超过 12% 时收紧到 8%（涨停/跌停日的"全波幅"不可执行）
    band_pct = min(band_pct, 0.08)

    band_label = f"±{band_pct*100:.1f}%（实时已实现 {((day_high or price)-(day_low or price))/max(price,1)*100:.1f}%）".replace("实时已实现 0.0%", "实时已实现 ~")

    # 2) 买/卖基础价（band 区间）
    buy = round(price * (1 - band_pct), 2)
    sell = round(price * (1 + band_pct), 2)
    stop_loss = round(price * (1 - band_pct * 1.5), 2)
    take_profit = round(price * (1 + band_pct * 1.5), 2)

    intraday_action = (intraday or {}).get("action") or (intraday or {}).get("scenario") or ""

    # 3) intraday target_price / stop_loss 优先
    if isinstance(intraday, dict):
        tp = intraday.get("target_price")
        sl = intraday.get("stop_loss")
        if tp and tp > 0:
            if "卖" in intraday_action or "止盈" in intraday_action:
                sell = max(sell, round(tp, 2))
                band_label += " · 实盘目标价" + f" → 上调到 {tp}"
            elif "买" in intraday_action or "低吸" in intraday_action or "加仓" in intraday_action:
                buy = min(buy, round(tp, 2))
                band_label += " · 实盘目标价" + f" → 下调到 {tp}"
        if sl and sl > 0:
            stop_loss = round(sl, 2)

    # 4) dynamic_levels 支撑/阻力吸附（离现价 < 5% 才吸附，避免跨日价干扰）
    support = resist = None
    if tl:
        d_buy = tl.get("buy")
        if d_buy and abs(d_buy - price) / max(price, 1) <= 0.05:
            buy = round(d_buy, 2)
            support = round(d_buy, 2)
        d_sell = tl.get("sell")
        if d_sell and abs(d_sell - price) / max(price, 1) <= 0.05:
            sell = max(sell, round(d_sell, 2))
            resist = round(d_sell, 2)
        else:
            support = round(tl.get("buy"), 2) if tl.get("buy") else None
            resist = round(tl.get("sell"), 2) if tl.get("sell") else None

    # 5) 当日 high/low 反向钳制（卖不超过当日高点×1.005、买不低于当日低点×0.995）
    if day_high and sell > day_high * 1.005:
        sell = round(day_high * 1.005, 2)
    if day_low and buy < day_low * 0.995:
        buy = round(day_low * 0.995, 2)

    # 6) r16: KDJ 极值吸附 —— 极度超卖时再向低点贴 +0.5%，极度超买时再向高点贴 -0.5%
    #    王总原话："持仓只看 KDJ+MACD+量能，最及时技术面"——把价位贴向 KDJ 极值点更精准
    _tm = (intraday or {}).get("metrics") or {}
    _kj = _tm.get("kdj_j")
    if _kj is not None and day_low and _kj < 10:
        _extreme = round(day_low * 1.005, 2)
        if _extreme < buy:
            buy = _extreme
            support = day_low
            band_label += f" · KDJ J={_kj:.0f}超卖→贴低点"
    if _kj is not None and day_high and _kj > 90:
        _extreme = round(day_high * 0.995, 2)
        if _extreme > sell:
            sell = _extreme
            resist = day_high
            band_label += f" · KDJ J={_kj:.0f}超买→贴高点"

    band_label = band_label.replace(" · 实盘目标价 → ", " · 实盘目标 → ")

    # r34：新增"日内短线"参考价（贴合现价 ±1%，可立即挂单位）
    # 王总原话："参考买点太低，不是当天的操作成本参考，我要短期的"——之前 buy 用日 K 波幅±3-8%，
    # 算出来对短线没意义。short_buy 才是真正能日内/次日挂上的位。
    _short_pct = 0.01  # 默认 ±1.0%
    # 若日内已大跌（价格 < VWAP 或 low 距离较大），放宽到 1.5% 给小回踩位
    try:
        _vwap = (intraday or {}).get("vwap")
        if _vwap and price < _vwap * 0.99:
            _short_pct = 0.015
        elif day_low and price and (price - day_low) / max(price, 1) > 0.025:
            _short_pct = 0.015  # 日内已大波，做 T 空间稍大
    except Exception:
        pass
    short_buy = round(price * (1 - _short_pct), 2)
    short_sell = round(price * (1 + _short_pct), 2)
    short_stop_loss = round(price * (1 - _short_pct * 1.5), 2)
    short_take_profit = round(price * (1 + _short_pct * 1.5), 2)
    short_band = f"日内短线 ±{_short_pct*100:.1f}%（{short_buy} ~ {short_sell}，止损 {short_stop_loss}/止盈 {short_take_profit}）"

    return {
        "buy": buy,
        "sell": sell,
        "stop_loss": stop_loss,
        "take_profit": take_profit,
        "buy_pct": round((buy - price) / price * 100, 2),
        "sell_pct": round((sell - price) / price * 100, 2),
        "band": band_label,
        "band_pct": round(band_pct, 4),
        "support": support,
        "resist": resist,
        "day_high": round(day_high, 2) if day_high else None,
        "day_low": round(day_low, 2) if day_low else None,
        # r34：日内短线参考买/卖点（紧贴现价 ±1~1.5%，可立即挂单）
        "short_buy": short_buy,
        "short_sell": short_sell,
        "short_stop_loss": short_stop_loss,
        "short_take_profit": short_take_profit,
        "short_band": short_band,
    }


# ---------- 自选股票实时重锚（/api/scan_status 返回前调用，避免 buy_price 锁死） ----------
def _refresh_scan_realtime(results, max_codes=200):
    """用当前实时价重锚每只候选股的 price/buy_price/sell_price。

    用户反馈"推荐我买药明康德 159.04，但现价已经 163" → scan_results 冻结时算的
    buy_price 一直显示。本函数在 /api/scan_status 返回前用 ds.fetch_realtime 重锚：
      - price = 实时价
      - band_pct 至少 2.5%（与持仓 tight 同款）
      - buy_price = price × (1 - band_pct), sell_price = price × (1 + band_pct)
      - 标记 rt_refreshed=True 与 rt_refreshed_at 时间戳
    max_codes 上限保护：避免一次扫 600+ 自选股拖慢轮询。
    """
    if not results:
        return 0
    sub = results[:max_codes]
    codes = [r.get("code") for r in sub if r.get("code")]
    if not codes:
        return 0
    try:
        rt = ds.fetch_realtime(codes) or {}
    except Exception:
        rt = {}
    n = 0
    for r in sub:
        code = r.get("code")
        quote = rt.get(code) or {}
        new_price = quote.get("price")
        if not new_price:
            continue
        day_high = quote.get("high")
        day_low = quote.get("low")
        # 实时动态 band_pct：至少 2.5%，按当日已实现波动扩张
        band_pct = 0.025
        if day_high and day_low and day_high > day_low and new_price > 0:
            day_band = (day_high - day_low) / new_price
            band_pct = max(band_pct, day_band * 0.7)
        band_pct = min(band_pct, 0.08)
        r["price"] = new_price
        r["change_pct"] = quote.get("change_pct") if quote.get("change_pct") is not None else r.get("change_pct")
        r["buy_price"] = round(new_price * (1 - band_pct), 2)
        r["sell_price"] = round(new_price * (1 + band_pct), 2)
        r["rt_band_pct"] = round(band_pct, 4)
        if day_high:
            r["today_high"] = round(day_high, 2)
        if day_low:
            r["today_low"] = round(day_low, 2)
        r["rt_refreshed"] = True
        n += 1
    if n:
        results[:max_codes] = sub  # 写回（如有切片）
    return n


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
# ========== r27 尾盘买入法（14:50 推荐 2-3 只大A纯主板，次日超短线） ==========
_TAIL_BUY_CACHE = {"ts": 0.0, "data": None}
_TAIL_BUY_TTL = 300  # 5 分钟缓存（避免重复扫几千只股票）

def _is_main_board(code):
    """大A纯主板：沪 60x/601x/603x/605x；深 000x/001x/002x
    排除：30x(创业板)、688x(科创板)、83x/87x/43x(北交所)、9xx(B 股)"""
    if not code:
        return False
    c = code.lower()
    # 沪市主板
    if c.startswith(("sh600", "sh601", "sh603", "sh605")):
        return True
    # 深市主板（000/001 中小板已并入主板，002 也算主板）
    if c.startswith(("sz000", "sz001", "sz002")):
        return True
    return False


def _compute_indicators(code, q=None):
    """从日线 K 线计算 MA5/10/20 + MACD 状态（红柱/绿柱）。
    实时接口不含这些字段，统一用日线回算；无 K线时返回全 0/空（评分相应规则不命中）。"""
    try:
        bars = ds.get_kline(code, "daily", 60, _tdx_path or None)
    except Exception:
        bars = []
    if not bars or len(bars) < 25:
        return {"ma5": 0, "ma10": 0, "ma20": 0, "macd_status": ""}
    closes = [b["close"] for b in bars if b.get("close") is not None]
    if len(closes) < 25:
        return {"ma5": 0, "ma10": 0, "ma20": 0, "macd_status": ""}
    try:
        ma5 = sma(closes, 5)[-1] or 0
        ma10 = sma(closes, 10)[-1] or 0
        ma20 = sma(closes, 20)[-1] or 0
    except Exception:
        ma5 = ma10 = ma20 = 0
    try:
        _, _, hist = macd(closes)
        h = hist[-1]
        macd_status = "红柱" if (h is not None and h > 0) else "绿柱" if (h is not None and h < 0) else ""
    except Exception:
        macd_status = ""
    return {"ma5": round(ma5, 3), "ma10": round(ma10, 3),
            "ma20": round(ma20, 3), "macd_status": macd_status}

def _tail_buy_score_row(q, ind):
    """按用户提供的 6 条策略评分（0~100）。ind 含 kdj/macd/ma/vol_ratio/main_fund_net/turnover"""
    score = 0
    rules_hit = []
    rules_miss = []
    price = q.get("price") or 0
    change_pct = q.get("change_pct") or 0  # 涨幅 %
    high = q.get("high") or 0
    low = q.get("low") or 0
    prev_close = q.get("prev_close") or 0
    turnover = q.get("turnover") or 0  # 换手率 %
    open_p = q.get("open") or 0
    vol_ratio = (ind or {}).get("vol_ratio") or 0
    main_fund_net = (ind or {}).get("main_fund_net") or 0  # 主力净流入（亿）
    ma5  = (ind or {}).get("ma5") or 0
    ma10 = (ind or {}).get("ma10") or 0
    ma20 = (ind or {}).get("ma20") or 0
    macd_status = (ind or {}).get("macd_status") or ""

    # 计算振幅
    if prev_close > 0 and high > 0 and low > 0:
        amp_pct = (high - low) / prev_close * 100
    else:
        amp_pct = 999  # 数据不足时给一个高分（不命中规则①）

    # ① 振幅 ≤ 3%（托盘）
    if amp_pct <= 3:
        score += 18
        rules_hit.append(f"振幅{amp_pct:.1f}%")
    elif amp_pct <= 5:
        score += 8
        rules_miss.append(f"振幅{amp_pct:.1f}%>3")
    else:
        rules_miss.append(f"振幅{amp_pct:.1f}%>3")

    # ② 涨幅 -2%~+3%（白线在黄线上方）
    if -2 <= change_pct <= 3:
        score += 17
        rules_hit.append(f"涨跌{change_pct:+.2f}%")
    else:
        rules_miss.append(f"涨跌{change_pct:+.2f}%∉[-2,3]")

    # ③ 量比 ≥ 1.2（且 < 5，太高是异动）
    if 1.2 <= vol_ratio <= 5:
        score += 16
        rules_hit.append(f"量比{vol_ratio:.2f}")
    elif vol_ratio >= 0.8:
        score += 5
        rules_miss.append(f"量比{vol_ratio:.2f}")
    else:
        rules_miss.append(f"量比{vol_ratio:.2f}")

    # ④ 5/10/20 日均线多头排列
    if ma5 > 0 and ma10 > 0 and ma20 > 0 and ma5 > ma10 > ma20 and price > ma5:
        score += 17
        rules_hit.append("5/10/20多头")
    elif ma5 > 0 and ma10 > 0 and ma20 > 0 and ma5 > ma10 > ma20:
        score += 8
        rules_miss.append("价在MA5下方")
    else:
        rules_miss.append("均线未多头")

    # ⑤ 主力净流入 > 0 且较大
    if main_fund_net > 0.5:
        score += 16
        rules_hit.append(f"主力+{main_fund_net:.2f}亿")
    elif main_fund_net > 0:
        score += 6
        rules_miss.append(f"主力+{main_fund_net:.2f}亿弱")
    else:
        rules_miss.append(f"主力{main_fund_net:+.2f}亿")

    # ⑥ MACD 红柱 / 金叉
    if macd_status and ("红柱" in macd_status or "金叉" in macd_status):
        score += 16
        rules_hit.append(f"MACD{macd_status}")
    else:
        rules_miss.append("MACD弱")

    # 换手率辅助分（1%-10% 最佳，过高是出货）
    if 1 <= turnover <= 10:
        score += 5
    return {
        "score": min(score, 100),
        "amp_pct": amp_pct,
        "rules_hit": rules_hit,
        "rules_miss": rules_miss,
    }


def _tail_buy_scan(force=False, top_n=3, pool_n=80):
    """扫描大A纯主板，按 r27 尾盘买入法策略评分，返回 top_n 推荐 + pool_n 候选池。"""
    global _TAIL_BUY_CACHE
    # 缓存命中
    if not force and _TAIL_BUY_CACHE["data"] and time.time() - _TAIL_BUY_CACHE["ts"] < _TAIL_BUY_TTL:
        return _TAIL_BUY_CACHE["data"]

    # 1) 取全 A 股代码池
    try:
        all_codes = _get_universe()
    except Exception:
        all_codes = []
    if not all_codes:
        return {"ok": False, "error": "股票池为空（先点设置里「重建成长池」或稍后再试）",
                "picks": [], "pool": []}
    main_codes = [c for c in all_codes if _is_main_board(c)]
    if not main_codes:
        return {"ok": False, "error": "主板股票池为空",
                "picks": [], "pool": []}

    # 2) 批量取富实时行情（东方财富 ulist 批量，一次返回 量比/主力净流入 等），缺失回退基础字段
    try:
        quotes = ds.fetch_realtime_extra(main_codes) or {}
    except Exception:
        quotes = {}

    # 3) 第一遍：用"便宜字段"（振幅/涨跌/量比/主力净流入）粗评，取前 40 进入 K线深度计算
    cheap = []
    for code in main_codes:
        q = quotes.get(code)
        if not q or q.get("price") is None:
            continue
        ind = {
            "vol_ratio": q.get("vol_ratio") or 0,
            "main_fund_net": q.get("main_fund_net") or 0,
            "ma5": 0, "ma10": 0, "ma20": 0, "macd_status": "",
        }
        s = _tail_buy_score_row(q, ind)
        cheap.append((code, q, s))
    cheap.sort(key=lambda x: -(x[2].get("score") or 0))

    # 4) 对前 40 只并行补算 MA5/10/20 + MACD（来自日线 K线，磁盘缓存），做最终评分
    #    首次扫描时每只都要在线拉 K线，顺序执行会卡 40~60s；用线程池并行压到 10s 内。
    scored = []
    top40 = cheap[:40]
    if top40:
        def _score_one(item):
            code, q, _ = item
            try:
                ind = _compute_indicators(code, q)
            except Exception:
                ind = {"ma5": 0, "ma10": 0, "ma20": 0, "macd_status": ""}
            s2 = _tail_buy_score_row(q, ind)
            price = q.get("price") or 0
            low = q.get("low") or price
            high = q.get("high") or price
            next_open = price * 1.001 if price > 0 else None   # 次日参考开（轻微高开）
            stop_loss = low * 0.97 if low > 0 else None
            take_profit = high * 1.03 if high > 0 else None
            return {
                "code": code,
                "name": q.get("name") or code,
                "price": q.get("price"),
                "change_pct": q.get("change_pct"),
                "vol_ratio": q.get("vol_ratio"),
                "turnover": q.get("turnover"),
                "main_fund_net": q.get("main_fund_net"),
                "amp_pct": s2["amp_pct"],
                "score": s2["score"],
                "rules_hit": s2["rules_hit"],
                "rules_miss": s2["rules_miss"],
                "ma5": ind.get("ma5"), "ma10": ind.get("ma10"),
                "ma20": ind.get("ma20"), "macd_status": ind.get("macd_status"),
                "next_open": round(next_open, 2) if next_open else None,
                "stop_loss": round(stop_loss, 2) if stop_loss else None,
                "take_profit": round(take_profit, 2) if take_profit else None,
            }
        with ThreadPoolExecutor(max_workers=12) as ex:
            scored = list(ex.map(_score_one, top40))

    # 5) 按最终评分排序
    scored.sort(key=lambda r: -(r.get("score") or 0))
    picks = scored[:top_n]
    pool = scored[top_n:pool_n]
    out = {
        "ok": True,
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "total_scanned": len(main_codes),
        "total_with_data": len(scored),
        "picks": picks,
        "pool": pool,
        "policy": {
            "amp_max": 3.0,
            "chg_range": [-2.0, 3.0],
            "vol_ratio_min": 1.2,
            "main_fund_min_yi": 0.5,
            "buy_window": "14:50~14:58",
            "stop_loss_rule": "次日跌破5日均线/震荡上沿，止损≤3%",
            "take_profit_rule": "次日涨3-5%止盈；放量冲高看5-7%但10:30前落袋",
        },
    }
    _TAIL_BUY_CACHE["data"] = out
    _TAIL_BUY_CACHE["ts"] = time.time()
    return out


# ========== r27 复盘视图：每日 9:25 预测 + 收盘核对 + 累计统计 ==========
REVIEW_HISTORY = os.path.join(DATA_DIR, "review_history.json")
STATIC_REVIEW_HISTORY = os.path.join(BASE, "static", "review_history.json")
REVIEW_PROGRESS = os.path.join(DATA_DIR, "review_progress.json")
STATIC_REVIEW_PROGRESS = os.path.join(BASE, "static", "review_progress.json")


def _load_review_history():
    """读取复盘历史：dict[date] = {date, generated_at, market_note, confidence, rows:[{code,name, open_pred,high_pred,low_pred,close_pred,amp_pred, dir_pred, ...actual...}]}"""
    rh = _load_json(REVIEW_HISTORY, None)
    if not rh:
        rh = _load_json(STATIC_REVIEW_HISTORY, {})
    return rh or {}


def _save_review_history(rh):
    _save_json(REVIEW_HISTORY, rh)
    try:
        _save_json(STATIC_REVIEW_HISTORY, rh)
    except Exception as e:
        print("[WARN] static review_history write failed (cloud may be read-only):", e)


def _predict_one_stock(code, name):
    """对单只股票做"今日预测"：开/高/低/收/涨跌幅。
    简化模型：基于昨收 + 当日开盘前的技术面（MA5/MA10/MA20 偏离度、KDJ/MACD、量能、换手、板块强度）。
    返回 {open_pred, high_pred, low_pred, close_pred, amp_pred, dir_pred, confidence}"""
    try:
        q = ds.fetch_realtime_extra([code]).get(code) or {}
    except Exception:
        q = {}
    # 技术面：MA5/10/20 + MACD 由日线 K线计算（实时接口不含这些字段）
    try:
        _ind = _compute_indicators(code, q)
    except Exception:
        _ind = {"ma5": 0, "ma10": 0, "ma20": 0, "macd_status": ""}
    price = q.get("price")
    prev_close = q.get("prev_close") or 0
    high = q.get("high") or prev_close
    low = q.get("low") or prev_close
    open_p = q.get("open") or prev_close
    change_pct = q.get("change_pct") or 0
    main_fund_net = q.get("main_fund_net") or 0
    vol_ratio = q.get("vol_ratio") or 1
    turnover = q.get("turnover") or 0
    ma5 = _ind.get("ma5") or 0
    ma10 = _ind.get("ma10") or 0
    ma20 = _ind.get("ma20") or 0
    macd_status = _ind.get("macd_status") or ""

    if prev_close <= 0:
        return None

    # 趋势分（基于均线偏离度）
    if ma5 > 0 and ma10 > 0 and ma20 > 0:
        ma_dev = (price - ma5) / ma5 * 100 if ma5 else 0
        ma_align = (1 if ma5 > ma10 > ma20 else -1 if ma5 < ma10 < ma20 else 0)
    else:
        ma_dev = 0
        ma_align = 0

    # MACD 信号
    macd_score = 1 if (macd_status and ("红柱" in macd_status or "金叉" in macd_status)) \
              else -1 if (macd_status and ("绿柱" in macd_status or "死叉" in macd_status)) \
              else 0

    # 主力净流入方向
    fund_score = 1 if main_fund_net > 0.2 else -1 if main_fund_net < -0.2 else 0

    # 综合趋势分（-3 ~ +3）
    trend_score = ma_align + macd_score + fund_score
    if trend_score >= 2:
        amp_pred = 1.8    # 偏多 → 预测涨 1.8%
        dir_pred = "up"
    elif trend_score == 1:
        amp_pred = 0.6
        dir_pred = "up"
    elif trend_score == 0:
        amp_pred = 0
        dir_pred = "flat"
    elif trend_score == -1:
        amp_pred = -0.6
        dir_pred = "down"
    else:
        amp_pred = -1.8
        dir_pred = "down"

    # 振幅预测（用于最高最低）
    if vol_ratio > 1.5:
        amp_range = 2.5
    elif vol_ratio > 1:
        amp_range = 1.5
    else:
        amp_range = 1.0

    # 开盘预测 = 昨收 * (1 + 跳空%)
    gap_pct = 0.0  # 默认平开
    if ma_align > 0 and macd_score > 0:
        gap_pct = 0.3
    elif ma_align < 0 and macd_score < 0:
        gap_pct = -0.3
    open_pred = round(prev_close * (1 + gap_pct / 100), 2)
    close_pred = round(prev_close * (1 + amp_pred / 100), 2)
    high_pred = round(max(open_pred, close_pred) * (1 + amp_range / 200), 2)
    low_pred = round(min(open_pred, close_pred) * (1 - amp_range / 200), 2)

    return {
        "open_pred": open_pred,
        "high_pred": high_pred,
        "low_pred": low_pred,
        "close_pred": close_pred,
        "amp_pred": round(amp_pred, 2),
        "dir_pred": dir_pred,
        "confidence": 60 + min(abs(trend_score) * 8, 30),
        "ref_prev_close": prev_close,
        "trend_score": trend_score,
        "fund_net": main_fund_net,
        "vol_ratio": vol_ratio,
    }


def _predict_review_today(scope="positions"):
    """为指定范围生成今日 9:25 预测；保存到 review_history。
    scope ∈ {positions, watchlist, all_main}；positions 保持同步（5 只内秒出），
    其它 scope 走异步任务（5000+ 只全主板不会卡死接口）。"""
    return _start_predict_task(scope) if scope != "positions" else _predict_review_today_sync()


def _predict_review_today_sync():
    """同步版：仅对当前持仓生成今日预测（原 r27 行为，保留兼容性）。"""
    positions = _load_positions()
    today = _today_str()
    rh = _load_review_history()
    existing = rh.get(today, {})
    rows = []
    for p in positions:
        code = p.get("code", "")
        if not code:
            continue
        name = p.get("name") or code
        pred = _predict_one_stock(code, name)
        if not pred:
            continue
        row = {"code": code, "name": name}
        row.update(pred)
        rows.append(row)
    rh[today] = {
        "date": today,
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "market_note": "",
        "confidence": 65 if rows else 0,
        "rows": rows,
        "stats": {},
    }
    _save_review_history(rh)
    return {"ok": True, "date": today, "count": len(rows), "scope": "positions"}


# ==================== r40o：异步预测任务（断点续跑 + 进度持久化） ====================
def _load_progress():
    """读进度（运行时优先 git 排除的 data/，云端兜底用 static/）。"""
    p = _load_json(REVIEW_PROGRESS, None)
    if p is not None:
        return p
    return _load_json(STATIC_REVIEW_PROGRESS, {})


def _save_progress(prog):
    """写进度：本地运行时写 data/，云端只读时写 static/ 兜底。"""
    try:
        _ensure_dir(DATA_DIR)
        with open(REVIEW_PROGRESS, "w", encoding="utf-8") as f:
            json.dump(prog, f, ensure_ascii=False, indent=2)
        return
    except Exception:
        pass
    try:
        os.makedirs(os.path.dirname(STATIC_REVIEW_PROGRESS), exist_ok=True)
        with open(STATIC_REVIEW_PROGRESS, "w", encoding="utf-8") as f:
            json.dump(prog, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print("[WARN] static review_progress write failed:", e)


def _predict_pool_for_scope(scope):
    """根据 scope 返回股票代码列表（含 name）。
    - positions: 持仓（5 只）
    - watchlist: 自选股
    - all_main: 纯主板 1788 只（沪市 600/601/603/605，按王总偏好）
    - all_market: 全 A 5407 只（含科创板/创业板/中小板）"""
    if scope in ("all_main", "all_market"):
        try:
            p = os.path.join(DATA_DIR, "universe.txt")
            raw = _load_json(p, "")  # 文本文件不能 json 读，回退
            if not raw:
                # 文本读取
                if os.path.exists(p):
                    with open(p, "r", encoding="utf-8") as f:
                        raw = [ln.strip() for ln in f if ln.strip() and not ln.startswith("#")]
                else:
                    raw = []
        except Exception:
            raw = []
        if not raw:
            try:
                raw = ds.refresh_universe(p) if 'p' in dir() else []
            except Exception:
                raw = []
        if scope == "all_main":
            # 沪市主板 600/601/603/605（王总偏好"纯主板"：不含科创板 688、创业板 300/301、中小板 002/003）
            raw = [c for c in raw if c.startswith("sh") and c[2:5] in ("600", "601", "603", "605")]
        # all_market: 全 A 5407 只（含科创板/创业板/中小板）
        return [{"code": c, "name": c} for c in raw]
    if scope == "watchlist":
        return [{"code": w.get("code", ""), "name": w.get("name") or w.get("code", "")}
                for w in _load_watchlist() if w.get("code")]
    # 默认 positions
    return [{"code": p.get("code", ""), "name": p.get("name") or p.get("code", "")}
            for p in _load_positions() if p.get("code")]


# 单例任务状态
_predict_task = {"running": False, "stop": False, "thread": None, "scope": None, "started_at": None}


def _start_predict_task(scope):
    """启动异步预测任务；已在跑则返回 ongoing。"""
    if _predict_task["running"]:
        return {"ok": True, "running": True, "scope": _predict_task["scope"]}
    _predict_task["stop"] = False
    _predict_task["scope"] = scope
    _predict_task["started_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
    t = threading.Thread(target=_run_predict_async, args=(scope,), daemon=True)
    _predict_task["thread"] = t
    _predict_task["running"] = True
    t.start()
    return {"ok": True, "running": True, "scope": scope, "started_at": _predict_task["started_at"]}


def _stop_predict_task():
    _predict_task["stop"] = True
    return {"ok": True, "stop_requested": True}


def _run_predict_async(scope):
    """异步执行：循环预测池子里的代码，结果增量写入 review_history.json。
    断点续跑：跳过已 done（rh[today]["rows"] 里已有）的 code。"""
    today = _today_str()
    pool = _predict_pool_for_scope(scope)
    total = len(pool)
    rh = _load_review_history()
    day = rh.get(today, {}) or {}
    rows = day.get("rows", []) or []
    done_codes = {r.get("code") for r in rows if r.get("code")}

    prog = {
        "scope": scope,
        "today": today,
        "running": True,
        "started_at": _predict_task["started_at"],
        "total": total,
        "done": len(done_codes),
        "failed": 0,
        "last_code": None,
        "eta_sec": None,
        "progress_pct": (len(done_codes) / max(1, total) * 100) if total else 0,
    }
    _save_progress(prog)

    start_t = time.time()
    processed = 0
    for item in pool:
        if _predict_task["stop"]:
            break
        code = item["code"]
        name = item.get("name") or code
        if code in done_codes:
            continue
        try:
            pred = _predict_one_stock(code, name)
            if pred:
                row = {"code": code, "name": name}
                row.update(pred)
                rows.append(row)
                done_codes.add(code)
        except Exception as e:
            prog["failed"] = prog.get("failed", 0) + 1
            print(f"[predict] {code} failed: {e}")
        processed += 1

        # 每 10 只写一次 review_history（避免磁盘 IO 风暴）
        if processed % 10 == 0:
            day["rows"] = rows
            day["date"] = today
            day["generated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
            day["confidence"] = 65 if rows else 0
            day["stats"] = day.get("stats", {})
            rh[today] = day
            _save_review_history(rh)

        # 进度更新（每次）
        elapsed = time.time() - start_t
        i = prog["done"] + processed
        remaining = max(0, total - i)
        eta_sec = (elapsed / max(1, processed)) * remaining if processed > 0 else None
        prog.update({
            "done": len(done_codes),
            "last_code": code,
            "eta_sec": int(eta_sec) if eta_sec and eta_sec < 1e8 else None,
            "progress_pct": (i / max(1, total) * 100) if total else 0,
            "running": True,
        })
        _save_progress(prog)

    # 最终完整保存
    day["rows"] = rows
    day["date"] = today
    day["generated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
    day["confidence"] = 65 if rows else 0
    day["stats"] = day.get("stats", {})
    rh[today] = day
    _save_review_history(rh)

    prog["running"] = False
    prog["done"] = len(done_codes)
    prog["progress_pct"] = 100.0 if total else 0
    _save_progress(prog)
    _predict_task["running"] = False


# 末尾再保留旧 _predict_review_today 同步主体（已被 _predict_review_today_sync 包装）


def _check_review_today(date=None):
    """核对今日（或指定日期）预测：拉真实开/高/低/收，比对方向/幅度/高低。"""
    date = date or _today_str()
    rh = _load_review_history()
    day = rh.get(date)
    if not day or not day.get("rows"):
        return {"ok": False, "error": f"{date} 没有预测数据，请先生成预测"}
    # 拉今日持仓的实际行情
    rows = day["rows"]
    codes = [r["code"] for r in rows]
    rt = {}
    try:
        rt = ds.fetch_realtime(codes) or {}
    except Exception:
        pass
    dir_hit = dir_miss = amp_hit = amp_miss = hi_hit = hi_miss = lo_hit = lo_miss = 0
    for r in rows:
        q = rt.get(r["code"]) or {}
        if not q:
            continue
        actual_open = q.get("open") or 0
        actual_high = q.get("high") or 0
        actual_low = q.get("low") or 0
        actual_close = q.get("price") or 0
        actual_amp = q.get("change_pct") or 0
        if actual_open <= 0 or actual_close <= 0:
            continue
        r["open_actual"] = actual_open
        r["high_actual"] = actual_high
        r["low_actual"] = actual_low
        r["close_actual"] = actual_close
        r["amp_actual"] = round(actual_amp, 2)
        r["dir_actual"] = "up" if actual_amp > 0.1 else "down" if actual_amp < -0.1 else "flat"
        # 方向
        if r.get("dir_pred") == r["dir_actual"]:
            r["dir_hit"] = True; dir_hit += 1
        else:
            r["dir_hit"] = False; dir_miss += 1
        # 幅度（绝对误差 < 1% 算命中）
        if r.get("amp_pred") is not None:
            err = abs(r["amp_actual"] - r["amp_pred"])
            r["amp_err"] = round(err, 2)
            r["amp_hit"] = err < 1
            if r["amp_hit"]: amp_hit += 1
            else: amp_miss += 1
        # 最高（误差 < 1%）
        if r.get("high_pred") and actual_high > 0:
            err_pct = abs(actual_high - r["high_pred"]) / max(r["high_pred"], 0.01) * 100
            r["hi_hit"] = err_pct < 1
            if r["hi_hit"]: hi_hit += 1
            else: hi_miss += 1
        # 最低
        if r.get("low_pred") and actual_low > 0:
            err_pct = abs(actual_low - r["low_pred"]) / max(r["low_pred"], 0.01) * 100
            r["lo_hit"] = err_pct < 1
            if r["lo_hit"]: lo_hit += 1
            else: lo_miss += 1
    # 写入当日统计
    total = dir_hit + dir_miss
    day["stats"] = {
        "total": total,
        "dir_hit": dir_hit, "dir_miss": dir_miss,
        "amp_hit": amp_hit, "amp_miss": amp_miss,
        "hi_hit": hi_hit, "hi_miss": hi_miss,
        "lo_hit": lo_hit, "lo_miss": lo_miss,
    }
    rh[date] = day
    _save_review_history(rh)
    return {"ok": True, "date": date, "dir_hit": dir_hit, "dir_total": total, "stats": day["stats"]}


def _review_stats():
    """累计统计：总天数、方向正确率、幅度 MAE、最高价正确率、最低价正确率。"""
    rh = _load_review_history()
    total_days = 0
    total_dir_hit = total_dir_miss = 0
    total_amp_hit = total_amp_miss = 0
    total_hi_hit = total_hi_miss = 0
    total_lo_hit = total_lo_miss = 0
    amp_err_sum = amp_err_n = 0
    for date, day in sorted(rh.items()):
        st = day.get("stats") or {}
        if not st:
            continue
        total_days += 1
        total_dir_hit += st.get("dir_hit", 0)
        total_dir_miss += st.get("dir_miss", 0)
        total_amp_hit += st.get("amp_hit", 0)
        total_amp_miss += st.get("amp_miss", 0)
        total_hi_hit += st.get("hi_hit", 0)
        total_hi_miss += st.get("hi_miss", 0)
        total_lo_hit += st.get("lo_hit", 0)
        total_lo_miss += st.get("lo_miss", 0)
        for r in (day.get("rows") or []):
            if r.get("amp_err") is not None:
                amp_err_sum += r["amp_err"]; amp_err_n += 1
    dir_total = total_dir_hit + total_dir_miss
    return {
        "total_days": total_days,
        "dir_total": dir_total,
        "dir_hit": total_dir_hit,
        "dir_acc": round(total_dir_hit / dir_total * 100, 1) if dir_total else 0,
        "amp_mae": round(amp_err_sum / amp_err_n, 2) if amp_err_n else 0,
        "hi_total": total_hi_hit + total_hi_miss,
        "hi_acc": round(total_hi_hit / (total_hi_hit + total_hi_miss) * 100, 1) if (total_hi_hit + total_hi_miss) else 0,
        "lo_total": total_lo_hit + total_lo_miss,
        "lo_acc": round(total_lo_hit / (total_lo_hit + total_lo_miss) * 100, 1) if (total_lo_hit + total_lo_miss) else 0,
    }


def _review_history(days=60):
    """返回历史记录列表（按日期倒序，最多 days 天）。"""
    rh = _load_review_history()
    items = []
    for date in sorted(rh.keys(), reverse=True)[:days]:
        d = rh[date]
        items.append({
            "date": date,
            "market_note": d.get("market_note", ""),
            "rows": d.get("rows", []),
            "stats": d.get("stats", {}),
        })
    return {"history": items}


def _review_today():
    """返回今日预测。"""
    rh = _load_review_history()
    today = _today_str()
    return {"prediction": rh.get(today, {}), "date": today}


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
            # r34：富行情（量比/换手/最高/最低）——给左栏"持仓股实时监控"行用
            rt_extra = {}
            if codes:
                try:
                    rt_extra = ds.fetch_realtime_extra(codes) or {}
                except Exception:
                    rt_extra = {}
            out = []
            total_value = 0.0
            for p in positions:
                code = p.get("code")
                _rt = rt.get(code) or {}
                adv = _advise_position(code, capital, _rt.get("price"), _rt.get("prev_close"))
                price = _rt.get("price")
                change_pct = _rt.get("change_pct")
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
                # r34：补 turn/volume_ratio/high/low 给左栏行渲染
                _qe = rt_extra.get(code) or {}
                if _qe.get("turnover") is not None:
                    adv["turnover"] = _qe["turnover"]
                if _qe.get("vol_ratio") is not None:
                    adv["vol_ratio"] = _qe["vol_ratio"]
                # 振幅 = (今高-今低)/昨收
                try:
                    _hi = _qe.get("high") or _rt.get("high")
                    _lo = _qe.get("low") or _rt.get("low")
                    _pc = _rt.get("prev_close") or adv.get("prev_close")
                    if _hi is not None and _lo is not None and _pc:
                        adv["amplitude"] = round((_hi - _lo) / _pc * 100, 2)
                    if _hi is not None:
                        adv["today_high"] = _hi
                    if _lo is not None:
                        adv["today_low"] = _lo
                except Exception:
                    pass
                # 迷你趋势 K 线（近 12 日收盘），给左栏"趋势"列用
                try:
                    _kb = _cache_get(code, "daily", 60) or ds.get_kline(code, "daily", 60, _tdx_path or None)
                    _cache_set(code, "daily", 60, _kb)
                    if _kb:
                        adv["spark"] = [round(b["close"], 2) for b in _kb[-12:]]
                except Exception:
                    pass
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
            series = sig._strip_series_for_payload(ind) if ind else None
            # only last indicator value, 用于 KPI 紧凑显示
            indicators_lite = None
            if ind and bars:
                _last = lambda arr: arr[-1] if arr and arr[-1] is not None else None
                indicators_lite = {
                    "ma5": _last(ind["ma5"]), "ma10": _last(ind["ma10"]), "ma20": _last(ind["ma20"]),
                    "kdj_k": _last(ind["kdj"]["k"]), "kdj_d": _last(ind["kdj"]["d"]), "kdj_j": _last(ind["kdj"]["j"]),
                    "macd_dif": _last(ind["macd"]["dif"]), "macd_dea": _last(ind["macd"]["dea"]), "macd_hist": _last(ind["macd"]["hist"]),
                    "rsi6": _last(ind["rsi"]["rsi6"]), "rsi12": _last(ind["rsi"]["rsi12"]), "rsi24": _last(ind["rsi"]["rsi24"]),
                    "boll_up": _last(ind["boll"]["upper"]), "boll_low": _last(ind["boll"]["lower"]), "boll_mid": _last(ind["boll"]["mid"]),
                }
            self._send(200, {"code": code, "period": period, "bars": bars,
                              "indicators": ind, "indicators_lite": indicators_lite,
                              "series": series})
            return
        if route == "/api/quotes":
            codes = qs.get("codes", [""])[0].replace(" ", ",").split(",")
            codes = [c for c in codes if c]
            self._send(200, ds.fetch_realtime(codes))
            return
        if route == "/api/market_sentiment":
            # 大盘全局情绪（超短线四维决策之四）：指数涨跌/涨跌家数/涨停跌停/成交额/情绪标签
            try:
                force = (qs.get("force", ["0"])[0] in ("1", "true"))
                self._send(200, msent.get_market_sentiment(force=force))
            except Exception as e:
                self._send(200, {"ok": False, "msg": "大盘情绪获取失败：" + str(e)})
            return
        if route == "/api/signal":
            code = qs.get("code", [""])[0]
            period = qs.get("period", ["daily"])[0]
            limit = int(qs.get("limit", ["120"])[0])
            if not code:
                self._send(400, {"error": "code required"})
                return
            # r38：30 秒内同 code+period+limit 重复请求直接命中缓存
            # 缓存键需要把 query string 中的 capital/current_shares 也带上（_build_position 会用）
            _cap = qs.get("capital", [""])[0]
            _hold = qs.get("current_shares", [""])[0]
            cache_key = ("signal", code, period, limit, _cap, _hold)
            cached = _json_cache_get(_signal_cache, _signal_lock, cache_key, 30)
            if cached is not None:
                self._send(200, cached)
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
            # v3.1 行情看板个股详情：补齐技术进度条(tech_short)与三档价位(tight)，
            # 使详情面板与持仓卡片(hbCardHtml)用同一套字段渲染。
            if a.get("ok"):
                _ind = a.get("indicators") or {}
                _kdj = _ind.get("kdj") or {}
                _macd = _ind.get("macd") or {}
                _j = _kdj.get("j")
                _hist = _macd.get("hist")
                _vol_ratio = None
                try:
                    _vols = [b.get("volume") for b in bars if b.get("volume") is not None]
                    if len(_vols) >= 5 and sum(_vols[-5:]) > 0:
                        _vol_ratio = _vols[-1] / (sum(_vols[-5:]) / 5)
                except Exception:
                    _vol_ratio = None
                a["tech_short"] = {
                    "kdj_j": _j,
                    "kdj_status": "超买" if (_j is not None and _j > 80) else "超卖" if (_j is not None and _j < 20) else None,
                    "macd_status": "红柱" if (_hist is not None and _hist > 0) else "绿柱" if (_hist is not None and _hist < 0) else None,
                    "vol_ratio": round(_vol_ratio, 2) if _vol_ratio else None,
                }
                _pl = a.get("price_levels") or {}
                _price = a.get("price") or 0
                a["tight"] = {
                    "buy": _pl.get("buy") or (round(_price * 0.97, 2) if _price else None),
                    "stop_loss": round(_price * 0.95, 2) if _price else None,
                    "take_profit": _pl.get("sell") or (round(_price * 1.05, 2) if _price else None),
                }
            # r29：附加 bars（r29 交易计划面板需 SVG 自绘折线图）
            try:
                a["bars"] = bars or []
            except Exception:
                pass
            _json_cache_set(_signal_cache, _signal_lock, cache_key, a)
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
            refreshed = _refresh_scan_realtime(_scan["results"])
            self._send(200, {"running": _scan["running"], "total": _scan["total"],
                             "done": _scan["done"], "results": _scan["results"][:200],
                             "error": _scan["error"], "scope": _scan["scope"],
                             "strategy": _scan["strategy"],
                             "rt_refreshed": refreshed,
                             "rt_refreshed_at": time.strftime("%Y-%m-%d %H:%M:%S")})
            return
        if route == "/api/trade_log":
            # 今日成交明细（刷新不丢）。可选参数：?date=YYYY-MM-DD；不传则返回今天。
            # 修复：r11 之前误放在 do_POST 里，前端 GET 永远 404 → 移到 do_GET
            log = _load_json(TRADE_LOG, []) or []
            qd = (qs.get("date") or [None])[0]
            if not qd:
                qd = time.strftime("%Y-%m-%d")
            rows = [r for r in log if r.get("date") == qd]
            # 同时给今日的现金流（买入支出/卖出收入）
            buy_amt = round(sum(r["amount"] for r in rows if r["side"] == "buy"), 2)
            sell_amt = round(sum(r["amount"] for r in rows if r["side"] == "sell"), 2)
            self._send(200, {"ok": True, "date": qd, "rows": rows,
                             "buy_amt": buy_amt, "sell_amt": sell_amt,
                             "net": round(sell_amt - buy_amt, 2)})
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

        # ========== r31 两套短线量化策略接口 ==========
        if route == "/api/strategy/overnight":
            code = qs.get("code", [""])[0]
            if not code:
                self._send(400, {"error": "code required"})
                return
            # r38：60 秒内同 code 重复请求直接命中缓存，避免每次都跑 30m/60m/实时价三步
            cache_key = ("overnight", code)
            cached = _json_cache_get(_strategy_cache, _strategy_lock, cache_key, 60)
            if cached is not None:
                self._send(200, cached)
                return
            try:
                bars_day = ds.get_kline(code, "daily", 120, _tdx_path or None)
                bars_30m = ds.fetch_kline_em(code, "30m", 80)
                bars_60m = ds.fetch_kline_em(code, "60m", 60)
                q = (ds.fetch_realtime_extra([code]) or {}).get(code) or {}
                price = q.get("price")
                prev_close = q.get("prev_close")
                name = q.get("name") or code
                r = strat.overnight_score(code, bars_day, bars_30m, bars_60m, price, prev_close, name)
            except Exception as e:
                r = {"ok": False, "mode": "overnight", "msg": "计算失败：" + str(e)}
            _json_cache_set(_strategy_cache, _strategy_lock, cache_key, r)
            self._send(200, r)
            return
        if route == "/api/strategy/intraday":
            code = qs.get("code", [""])[0]
            cost = qs.get("cost", [""])[0]
            try:
                cost = float(cost) if cost else None
            except Exception:
                cost = None
            if not code:
                self._send(400, {"error": "code required"})
                return
            # r38：60 秒内同 code 重复请求直接命中缓存
            cache_key = ("intraday", code, cost)
            cached = _json_cache_get(_strategy_cache, _strategy_lock, cache_key, 60)
            if cached is not None:
                self._send(200, cached)
                return
            try:
                bars_1m = ds.fetch_kline_em(code, "1m", 240)
                if not bars_1m or len(bars_1m) < 30:
                    fb = ds.get_kline(code, "5m", 120, _tdx_path or None)
                    if fb and len(fb) >= 30:
                        bars_1m = fb  # 1m 不可达 → 用 5m 近似
                bars_5m = ds.get_kline(code, "5m", 80, _tdx_path or None)
                q = (ds.fetch_realtime_extra([code]) or {}).get(code) or {}
                price = q.get("price")
                prev_close = q.get("prev_close")
                name = q.get("name") or code
                if cost is None:
                    cost = _position_cost(code)
                r = strat.intraday_t_signal(code, bars_1m, bars_5m, cost, price, name, prev_close)
            except Exception as e:
                r = {"ok": False, "mode": "intraday", "msg": "计算失败：" + str(e)}
            _json_cache_set(_strategy_cache, _strategy_lock, cache_key, r)
            self._send(200, r)
            return

        # ========== r32 两套策略历史回测接口 ==========
        if route == "/api/backtest/overnight":
            code = qs.get("code", [""])[0]
            if not code:
                self._send(400, {"error": "code required"})
                return
            try:
                r = bt.backtest_overnight(code, 600, code)
            except Exception as e:
                r = {"ok": False, "mode": "overnight", "msg": "回测失败：" + str(e)}
            self._send(200, r)
            return
        if route == "/api/backtest/intraday":
            code = qs.get("code", [""])[0]
            if not code:
                self._send(400, {"error": "code required"})
                return
            try:
                r = bt.backtest_intraday(code, 1200, code)
            except Exception as e:
                r = {"ok": False, "mode": "intraday", "msg": "回测失败：" + str(e)}
            self._send(200, r)
            return

        # ========== r27 尾盘买入法 + 复盘视图 4 个 GET 端点 ==========
        if route == "/api/tail_buy":
            try:
                force = qs.get("force", [""])[0] in ("1", "true", "yes")
                data = _tail_buy_scan(force=force)
                self._send(200, data)
            except Exception as e:
                self._send(200, {"ok": False, "error": str(e), "picks": [], "pool": []})
            return
        if route == "/api/review/today":
            self._send(200, _review_today())
            return
        if route == "/api/review/history":
            days = int(qs.get("days", ["60"])[0] or 60)
            self._send(200, _review_history(days=days))
            return
        if route == "/api/review/stats":
            self._send(200, {"stats": _review_stats()})
            return
        if route == "/api/review/progress":
            # r40o：预测任务进度（前端 1 秒轮询）
            self._send(200, _load_progress())
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
            # 同时追加一条记录到 trade_log.json（前端可查今日已成交清单）。
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
            old_cost = 0.0
            old_shares = 0
            new_cost = 0.0
            new_shares = 0
            name = code
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
                old_cost = oldcost
                old_shares = old
                new_cost = round((oldcost * old + price * qty) / new, 4) if new > 0 else 0.0
                rec["cost"] = new_cost
                rec["shares"] = new
                rec["name"] = item.get("name") or rec.get("name") or code
                new_shares = new
                name = rec.get("name") or code
            else:
                if rec is None:
                    self._send(400, {"error": "未持有该股票，无法卖出"})
                    return
                old = int(rec.get("shares", 0) or 0)
                if qty > old:
                    self._send(400, {"error": f"卖出数量 {qty} 超过持仓 {old}"})
                    return
                old_cost = float(rec.get("cost", 0) or 0)
                old_shares = old
                rec["shares"] = old - qty
                if rec["shares"] <= 0:
                    positions = [p for p in positions if p.get("code") != code]
                new_shares = rec.get("shares", 0)
                new_cost = old_cost
                name = rec.get("name") or code
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
            # 写 trade_log（前端可查今日成交明细，刷新不丢）
            try:
                log = _load_json(TRADE_LOG, []) or []
                log.append({
                    "id": int(time.time() * 1000),
                    "ts": time.strftime("%Y-%m-%d %H:%M:%S"),
                    "date": time.strftime("%Y-%m-%d"),
                    "code": code, "name": name,
                    "side": side, "qty": qty, "price": price,
                    "amount": round(price * qty, 2),
                    "before_shares": old_shares, "before_cost": round(old_cost, 4),
                    "after_shares": new_shares, "after_cost": round(new_cost, 4),
                    "cash_after": float(acct.get("cash", 0) or 0),
                })
                _save_json(TRADE_LOG, log)
                try:
                    _save_json(STATIC_TRADE_LOG, log)
                except Exception as e:
                    print("[WARN] static trade_log write failed (cloud may be read-only):", e)
            except Exception as e:
                print("[WARN] trade_log write failed:", e)
            self._send(200, {"ok": True, "cash": acct["cash"],
                             "positions": positions,
                             "log_id": int(time.time() * 1000)})
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

        # ========== r27 复盘视图 2 个 POST 端点 ==========
        if route == "/api/review/predict":
            # 立即生成今日 9:25 预测（基于当前持仓 + 当前技术指标）
            # r40o：支持 scope 参数：positions（同步，5 只秒出）/ watchlist / all_main（异步，断点续跑）
            try:
                scope = "positions"
                if self.command == "POST":
                    length = int(self.headers.get("Content-Length", 0) or 0)
                    body = json.loads(self.rfile.read(length) or b"{}") if length else {}
                else:
                    body = {}
                scope = (body.get("scope") or qs.get("scope", ["positions"])[0] or "positions").strip()
                if scope not in ("positions", "watchlist", "all_main", "all_market"):
                    scope = "positions"
                result = _predict_review_today(scope=scope)
                self._send(200, result)
            except Exception as e:
                self._send(200, {"ok": False, "error": str(e)})
            return
        if route == "/api/review/progress":
            # r40o：查询预测任务进度（前端轮询）
            self._send(200, _load_progress())
            return
        if route == "/api/review/predict/stop":
            # r40o：停止预测任务
            try:
                self._send(200, _stop_predict_task())
            except Exception as e:
                self._send(200, {"ok": False, "error": str(e)})
            return
        if route == "/api/review/check":
            # 核对今日实际涨跌 / 最高 / 最低 / 收盘
            try:
                date = payload.get("date") if isinstance(payload, dict) else None
                result = _check_review_today(date=date)
                self._send(200, result)
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

    # 板块强弱预热的守护线程：启动时先拉一次（避免首屏 30s 冷启），
    # 之后在交易时段每 50s 续热（略低于 60s TTL，保证不回冷），非交易时段 5min 一次。
    def _sector_warmer():
        while True:
            try:
                sf._refresh_strength()   # 后台唯一写者：重算并写入 60s 缓存，不阻塞请求
            except Exception:
                pass
            h = time.localtime().tm_hour
            if 9 <= h < 15 or (h == 15 and time.localtime().tm_min <= 10):
                time.sleep(50)
            else:
                time.sleep(300)
    threading.Thread(target=_sector_warmer, daemon=True).start()

    # 服务端后台调度：自动生成开盘判断 + 四时点快照 + 收盘复盘（不依赖浏览器是否打开）
    # 交易时段(9:00-15:10)每 20 秒检查一次，更敏捷（原来 60s 偶发延迟到时点后 60s 才出现）；
    # 30 分钟无变化（scheduler_heartbeat 留住证据），如崩了重启即补。其余时间 5 分钟一次，省资源
    import os as _os
    HEARTBEAT_FILE = _os.path.join(DATA_DIR, "_scheduler_heartbeat.json")

    def _write_heartbeat(note):
        try:
            _save_json(HEARTBEAT_FILE, {"ts": time.strftime("%Y-%m-%d %H:%M:%S"), "note": note})
        except Exception:
            pass

    def _daily_scheduler():
        last_alive = 0
        while True:
            try:
                _write_heartbeat("tick")
                run_daily("auto")
            except Exception as e:
                _write_beat_error = True
                try:
                    _save_json(HEARTBEAT_FILE, {"ts": time.strftime("%Y-%m-%d %H:%M:%S"), "error": str(e)})
                except Exception:
                    pass
            h, m = time.localtime().tm_hour, time.localtime().tm_min
            if 9 <= h < 15 or (h == 15 and m <= 10):
                time.sleep(20)
            else:
                time.sleep(300)
    _write_heartbeat("started")
    threading.Thread(target=_daily_scheduler, daemon=True).start()

    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.shutdown()


if __name__ == "__main__":
    main()
