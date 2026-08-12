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

BASE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE, "data")
WATCHLIST = os.path.join(DATA_DIR, "watchlist.json")
ALERTS = os.path.join(DATA_DIR, "alerts.json")
POSITIONS = os.path.join(DATA_DIR, "positions.json")
# 云端/本地共用的持仓主源（git 跟踪，公开 URL 可达，部署/重启不丢）
STATIC_POSITIONS = os.path.join(BASE, "static", "positions.json")
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
        return [c for c in _load_json(WATCHLIST, []) if c]
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
    # 当日实时买卖价带宽
    try:
        bars5m = _cache_get(code, "5m", 60) or ds.get_kline(code, "5m", 60, _tdx_path or None)
        _cache_set(code, "5m", 60, bars5m)
        tl = sig.today_levels(bars5m, pct=0.03)
    except Exception:
        tl = None
    price = a.get("price")
    prev_close = a.get("prev_close")
    regime = None
    if _ss:
        regime = {"track": _ss.get("track"), "sector": _ss.get("sector"),
                  "trend_pct": _ss.get("trend_pct"), "fund_net": _ss.get("fund_net"),
                  "up_ratio": _ss.get("up_ratio")}
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
    # 操作价：买用当日买点/支撑，卖用当日卖点/阻力
    pl = a.get("price_levels") or {}
    if action == "买入":
        op_price = (tl or {}).get("buy") or pl.get("buy")
    elif action == "卖出":
        op_price = (tl or {}).get("sell") or pl.get("sell")
    else:
        op_price = None
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
    return {
        "code": code, "ok": True,
        "name": _fp.get("name") or code,
        "shares": held,
        "price": price,
        "action": action,
        "action5": a["action"],
        "score": a["score"],
        "op_price": round(op_price, 2) if op_price else None,
        "op_qty": op_qty,
        "reason": (outlook or {}).get("reason") or (a.get("reasons")[0]["text"] if a.get("reasons") else ""),
        "regime": regime,
        "indicators": a.get("indicators"),
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
                total_value += (price or 0) * shares
                out.append(adv)
            self._send(200, {"ok": True, "capital": capital,
                             "market_value": round(total_value, 2),
                             "total_value": round(total_value + capital, 2),
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
                # 当日实时买卖价：基于今日开盘价±比例，给「当天波动就卖/买」的及时建议
                try:
                    bars5m = _cache_get(code, "5m", 60) or ds.get_kline(code, "5m", 60, _tdx_path or None)
                    _cache_set(code, "5m", 60, bars5m)
                    tl = sig.today_levels(bars5m, pct=0.03)  # 当日做T带宽 ±3%；想要例子里的±5%改成 0.05
                except Exception:
                    tl = None
                a["today"] = tl
                if a.get("position") and tl:
                    a["position"]["today_buy"] = tl.get("buy")
                    a["position"]["today_sell"] = tl.get("sell")
                    a["position"]["today_open"] = tl.get("open")
                # 自适应买卖建议：板块资金流出+下跌 → 先减仓防跌，跌停才低吸买回
                regime = None
                if _ss:
                    regime = {"track": _ss.get("track"), "sector": _ss.get("sector"),
                              "trend_pct": _ss.get("trend_pct"), "fund_net": _ss.get("fund_net"),
                              "up_ratio": _ss.get("up_ratio")}
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
            self._send(200, _load_json(WATCHLIST, []))
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
            codes = payload.get("codes", []) if isinstance(payload, dict) else payload
            codes = [str(c) for c in codes if c]
            _save_json(WATCHLIST, codes)
            self._send(200, {"ok": True, "codes": codes})
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
            _save_json(POSITIONS, positions)
            self._send(200, {"ok": True, "positions": positions})
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
            _save_json(POSITIONS, positions)
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
        results.sort(key=lambda x: x["score"], reverse=True)
        self._attach_news(results, "score", 20)
        return results

    def _run_candidate_screener(self, codes, limit, capital, strategy="composite", progress_cb=None):
        """候选股扫描（十五五成长池）：技术面 55% + 基本面 45% 综合打分。

        基本面弱（估值/质量档）会门控买信号，避免夕阳/垃圾股被技术反弹误选。
        """
        results = []
        lot = _POS.get("lot", 100)
        # 实时估值（best-effort）后台拉取，不阻塞扫描进度
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
                pl = a.get("price_levels") or {}
                tech = a["score"]  # -100..100
                tech_norm = max(0.0, min(100.0, (tech + 100) / 2))
                fp = ip.get_fund(code) or {}
                fund = fm.fundamental_score(fp.get("grade", "B"), valuations.get(code))
                sector = fp.get("sector")
                track = fp.get("track")
                ss = sf.sector_strength(track) if track else None
                sector_score = (ss or {}).get("score", 50) if ss else 50
                combined = round(tech_norm * 0.50 + fund * 0.40 + sector_score * 0.10, 1)
                price = a.get("price")
                # 候选股买卖价：用「当日实时价±2.5%」紧贴当前价（参考 MA20/MA5 + 当日分时）
                try:
                    bars5m = _cache_get(code, "5m", 60) or ds.get_kline(code, "5m", 60, _tdx_path or None)
                    _cache_set(code, "5m", 60, bars5m)
                except Exception:
                    bars5m = None
                cl = sig.candidate_levels(bars5m, bars, a.get("prev_close"))
                buy_price = cl["buy"] if cl else (round(price * 0.97, 2) if price else None)
                sell_price = cl["sell"] if cl else (round(price * 1.06, 2) if price else None)
                # 买信号门控：基本面弱或综合分低则降为「持有」
                act = a["action"]
                fund_ok = fund >= 60
                if act in ("买入", "强烈买入"):
                    if not fund_ok or combined < 55:
                        act = "持有"
                    elif combined >= 72 and act == "买入":
                        act = "强烈买入"
                # 买量（按可用资金 + 买价 + 手数）
                qty = 0
                if buy_price and buy_price > 0:
                    q = int(capital / buy_price // lot) * lot
                    qty = max(q, 0)
                return {
                    "code": code,
                    "name": fp.get("name") or code,
                    "track": track or "",
                    "action": act,
                    "tech_score": round(tech_norm, 1),
                    "fund_score": round(fund, 1),
                    "fund_grade": fp.get("grade", "B"),
                    "combined": combined,
                    "price": price,
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
                    "sector_trend": (ss or {}).get("trend_pct") if ss else None,
                    "sector_fund": (ss or {}).get("fund_net") if ss else None,
                    "up_ratio": (ss or {}).get("up_ratio") if ss else None,
                    "note": fp.get("note", ""),
                    "reasons": [r["text"] for r in a["reasons"][:2]],
                }
            except Exception:
                return None

        results = []
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
        vt.join(timeout=8)  # 尽量等估值回写，超时不影响（基本面按质量档兜底）
        results.sort(key=lambda x: x["combined"], reverse=True)
        self._attach_news(results, "combined", 30)
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
    print(f"股票工作台已启动： http://127.0.0.1:{port}")
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
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.shutdown()


if __name__ == "__main__":
    main()
