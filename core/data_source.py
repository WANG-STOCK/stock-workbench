"""数据源层：K线 / 实时行情 / 股票搜索 / 通达信本地数据。

优先级：
  - K线日线/周线：若配置了通达信 vipdoc 路径且本地文件存在，优先读本地（更快、可扫描全市场）；
    否则走新浪在线接口。
  - 分钟线：在线（新浪）。
  - 实时行情 / 搜索：腾讯接口。
"""

import os
import sys
import struct
import datetime
import urllib.request
import urllib.parse
import json

SINA_KLINE = "https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData"
SCALE_MAP = {"1m": 1, "5m": 5, "15m": 15, "30m": 30, "60m": 60, "daily": 240, "weekly": 1200}
TDX_PERIODS = ("daily", "weekly")

# K线磁盘缓存：让全市场扫描首次之后极快（按"当天"过期，次日自动刷新）
CACHE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                         "data", "cache", "kline")


def _http_get(url, referer="https://finance.sina.com.cn", timeout=12, decode="utf-8"):
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (compatible; stock-workbench/1.0)",
        "Referer": referer,
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode(decode)


# ---------------- 新浪在线 K线 ----------------
def fetch_kline_online(code, period="daily", limit=300):
    scale = SCALE_MAP.get(period, 240)
    url = f"{SINA_KLINE}?symbol={code}&scale={scale}&ma=no&datalen={limit}"
    raw = _http_get(url)
    data = json.loads(raw)
    bars = []
    for d in data:
        bars.append({
            "date": d["day"],
            "open": float(d["open"]),
            "high": float(d["high"]),
            "low": float(d["low"]),
            "close": float(d["close"]),
            "volume": float(d["volume"]),
        })
    return bars


# 东方财富 1 分钟线（新浪 scale=1 返回 null、腾讯 m1/min 接口不存在，故 1m 走东财）
def fetch_kline_em(code, period="1m", limit=60):
    market = "1" if code.startswith("sh") else "0"
    num = code[2:]
    secid = f"{market}.{num}"
    klt = {"1m": 1, "5m": 5, "15m": 15, "30m": 30, "60m": 60}.get(period, 1)
    url = (f"https://push2his.eastmoney.com/api/qt/stock/kline/get"
           f"?secid={secid}&fields1=f1,f2,f3,f4,f5,f6"
           f"&fields2=f51,f52,f53,f54,f55,f56,f57,f58"
           f"&klt={klt}&fqt=0&end=20500101&lmt={limit}")
    import subprocess
    raw = ""
    # Git Bash 子进程下：用 shell=True 让 bash 把 Windows 路径标准化后再调 curl；
    # 若用 ['curl', ...] 可能撞其它实现的 curl（rc=56）。东财 kline 端点容易被风控抖动，
    # 加重试 3 次，失败时 fallback 到 5 分钟（保证盘中建议面板始终有数据）
    try:
        for attempt in range(3):
            for hdr_args in (
                '-H "Referer: https://quote.eastmoney.com/" -H "Accept: */*"',
                '',
            ):
                cmd = f'curl -s --max-time 10 {hdr_args} "{url}"'.strip()
                out = subprocess.run(cmd, capture_output=True, text=True, timeout=13, shell=True)
                if out.returncode == 0 and out.stdout and '"klines"' in out.stdout and len(out.stdout) > 1000:
                    raw = out.stdout
                    break
            if raw:
                break
            import time as _t
            _t.sleep(1.0)
        # Fallback：东财 1m 拉不到时用 5m 数据顶上（盘中建议面板不断）
        if not raw and period == "1m":
            try:
                fb = fetch_kline_online(code, "5m", max(limit, 60))
                return fb or []
            except Exception:
                return []
        if not raw:
            return []
        data = json.loads(raw)
    except Exception:
        return []
    kl = data.get("data", {}).get("klines") if data.get("data") else None
    if not kl:
        return []
    bars = []
    for line in kl:
        parts = line.split(",")
        if len(parts) < 6:
            continue
        bars.append({
            "date": parts[0],
            "open": float(parts[1]), "close": float(parts[2]),
            "high": float(parts[3]), "low": float(parts[4]),
            "volume": float(parts[5]),
        })
    return bars


# ---------------- 通达信本地 ----------------
def read_tdx_day_file(path):
    bars = []
    with open(path, "rb") as f:
        buf = f.read()
    rec = 32
    n = len(buf) // rec
    for i in range(n):
        d = buf[i * rec:i * rec + rec]
        date, o, h, l, c, amt, vol, res = struct.unpack("<IIIIIfII", d)
        y, m, day = date // 10000, (date // 100) % 100, date % 100
        bars.append({
            "date": f"{y:04d}-{m:02d}-{day:02d}",
            "open": o / 100.0, "high": h / 100.0, "low": l / 100.0,
            "close": c / 100.0, "volume": float(vol),
        })
    return bars


def _tdx_daily_file(tdx_path, code):
    market = code[:2]
    num = code[2:]
    return os.path.join(tdx_path, market, "lday", f"{num}.day")


def read_tdx_daily(tdx_path, code):
    path = _tdx_daily_file(tdx_path, code)
    if not os.path.isfile(path):
        return None
    return read_tdx_day_file(path)


def aggregate_weekly(daily_bars):
    """把日线聚合成周线（按自然周，周一为界）。"""
    weeks = {}
    order = []
    for b in daily_bars:
        # 用日期字符串前7位作为周键（年-周数近似：直接用日期整除到周）
        import datetime
        dt = datetime.date.fromisoformat(b["date"])
        monday = dt - datetime.timedelta(days=dt.weekday())
        key = monday.isoformat()
        if key not in weeks:
            weeks[key] = {
                "date": key, "open": b["open"], "high": b["high"],
                "low": b["low"], "close": b["close"], "volume": b["volume"],
            }
            order.append(key)
        else:
            w = weeks[key]
            w["high"] = max(w["high"], b["high"])
            w["low"] = min(w["low"], b["low"])
            w["close"] = b["close"]
            w["volume"] += b["volume"]
    return [weeks[k] for k in order]


def list_tdx_codes(tdx_path):
    codes = []
    for market in ("sh", "sz"):
        d = os.path.join(tdx_path, market, "lday")
        if not os.path.isdir(d):
            continue
        for fn in os.listdir(d):
            if fn.endswith(".day"):
                codes.append(market + fn[:-4].upper())
    return codes


# ---------------- K线磁盘缓存 ----------------
def _kline_disk_path(code, period, limit):
    return os.path.join(CACHE_DIR, f"{code}_{period}_{limit}.json")


def _kline_disk_get(code, period, limit):
    p = _kline_disk_path(code, period, limit)
    if os.path.isfile(p):
        try:
            d = json.load(open(p, encoding="utf-8"))
            if d.get("date") == datetime.date.today().isoformat():
                return d.get("bars")
        except Exception:
            pass
    return None


def _kline_disk_set(code, period, limit, bars):
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        json.dump({"date": datetime.date.today().isoformat(), "bars": bars},
                  open(_kline_disk_path(code, period, limit), "w", encoding="utf-8"))
    except Exception:
        pass


# ---------------- 统一入口 ----------------
def get_kline(code, period="daily", limit=300, tdx_path=None):
    if period in TDX_PERIODS and tdx_path:
        daily = read_tdx_daily(tdx_path, code)
        if daily:
            if period == "weekly":
                bars = aggregate_weekly(daily)
            else:
                bars = daily
            return bars[-limit:] if limit else bars
    # 1 分钟线：新浪 scale=1 不返回数据、腾讯 m1/min 不存在，统一走东方财富（在线、不缓存，保证盘中时效）
    if period == "1m":
        return fetch_kline_em(code, period, limit)
    # 在线 + 磁盘缓存（避免每次全市场扫描都重新拉取）
    cached = _kline_disk_get(code, period, limit)
    if cached is not None:
        return cached
    bars = fetch_kline_online(code, period, limit)
    if bars:
        _kline_disk_set(code, period, limit, bars)
    return bars


# ---------------- 全 A 股代码池（在线生成，无需通达信） ----------------
def _chunk(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def generate_a_codes():
    """按上交所/深交所代码段批量生成候选 A 股代码（不含北交所）。"""
    ranges = [
        ("sh", 600000, 600999),
        ("sh", 601000, 601999),
        ("sh", 603000, 603999),
        ("sh", 605000, 605999),
        ("sh", 688000, 688999),   # 科创板
        ("sz", 1, 2999),          # 000001-002999 主板/中小板
        ("sz", 3000, 4999),       # 003000-004999 中小板
        ("sz", 300000, 301999),   # 创业板
    ]
    codes = []
    for market, lo, hi in ranges:
        for n in range(lo, hi + 1):
            codes.append(f"{market}{n:06d}")
    return codes


def validate_a_codes(codes, batch=80):
    """用腾讯实时接口批量校验，返回确有行情（有名称）的代码，并剔除已退市标的。"""
    valid = []
    for chunk in _chunk(codes, batch):
        try:
            rt = fetch_realtime(list(chunk))
            for c in chunk:
                v = rt.get(c)
                name = v.get("name") if v else ""
                if name and "退" not in name:   # 剔除"退市/退"等不再交易的代码
                    valid.append(c)
        except Exception:
            pass
    return valid


def refresh_universe(path):
    """生成并校验全 A 股代码池，写入 universe.txt，返回有效代码列表。"""
    codes = generate_a_codes()
    valid = validate_a_codes(codes)
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write("# 自动生成的全 A 股代码池（在线校验，无需通达信）\n")
            f.write("# 如需自定义，可在下方增删代码（每行一个，带市场前缀）\n")
            for c in valid:
                f.write(c + "\n")
    except Exception:
        pass
    return valid


# ---------------- 实时行情（腾讯） ----------------
def fetch_realtime(codes):
    if not codes:
        return {}
    url = "https://qt.gtimg.cn/q=" + ",".join(codes)
    raw = _http_get(url, referer="https://gu.qq.com", decode="gbk")
    results = {}
    for line in raw.split(";"):
        line = line.strip()
        if not line.startswith("v_"):
            continue
        name, _, val = line.partition("=")
        code = name[2:].strip('"')
        val = val.strip().strip('"')
        p = val.split("~")
        if len(p) < 35:
            continue
        try:
            results[code] = {
                "code": code,
                "name": p[1],
                "price": float(p[3]),
                "prev_close": float(p[4]),
                "open": float(p[5]),
                "volume": int(float(p[6])),
                "high": float(p[33]),
                "low": float(p[34]),
                "time": p[30],
                "change": float(p[31]),
                "change_pct": float(p[32]),
                "amplitude": _to_float(p[43]),
                "turnover": _to_float(p[38]),
                "pe": _to_float(p[39]),
            }
        except (ValueError, IndexError):
            continue
    return results


def _to_float(s):
    try:
        return float(s)
    except (ValueError, TypeError):
        return None


# ---------------- 股票搜索（腾讯 smartbox） ----------------
def search(q):
    url = "https://smartbox.gtimg.cn/s3/?v=2&t=all&q=" + urllib.parse.quote(q)
    raw = _http_get(url, referer="https://gu.qq.com", decode="gbk")
    res = []
    for line in raw.split(";"):
        line = line.strip()
        if not line.startswith("v_hint"):
            continue
        _, _, val = line.partition("=")
        val = val.strip().strip('"')
        p = val.split("~")
        if len(p) >= 3 and p[0] in ("sh", "sz", "hk", "us"):
            res.append({
                "code": p[0] + p[1],
                "name": _deunicode(p[2]),
                "market": p[0],
                "pinyin": p[3] if len(p) > 3 else "",
                "type": p[4] if len(p) > 4 else "",
            })
    return res


def _deunicode(s):
    """腾讯 smartbox 把中文以 \\uXXXX 形式返回，解码为正常中文。"""
    try:
        return s.encode("utf-8").decode("unicode_escape")
    except Exception:
        return s
