"""行业趋势与资金流（best-effort）。

- 行业趋势（稳）：用池内同 track（细分赛道，如 光纤/PCB/封测/电子化学品）成分股的
  实时涨跌幅均值（腾讯行情接口，不被限流）。比按大类更细，选股/做T 更有参考性。
- 资金流（best-effort）：尝试拉东财行业板块主力净流入，按大类 sector 归类；
  超时/失败降级为 None，不阻塞主流程。云端 Render 服务器 IP 与本地不同，通常能拿到。

输出：
- sector_strength(key)：key 为 track（细分赛道）时返回该赛道强度；
  key 为大类 sector（科技/医药/电力）时返回该大类聚合强度。
- all_sector_strength()：返回全部 track 的强度字典。
"""

import json
import urllib.request
import threading
import time

from core import industry_pool as ip
from core import data_source as ds

# 东财行业板块名 -> 我们的 sector 关键词映射（best-effort 资金流归类用）
_EASTMONEY_KEYWORDS = {
    "科技": ["半导体", "电子", "计算机", "软件", "通信", "人工智能", "芯片", "消费电子",
            "光学光电子", "元件", "军工", "航天", "卫星", "低空", "机器人", "PCB", "封测"],
    "医药": ["医药", "医疗", "生物", "化学制药", "中药", "医疗器械", "医疗服务", "生物制品"],
    "电力": ["电力", "光伏", "风电", "新能源", "电网", "储能", "特高压", "核电", "电源设备", "电池"],
}

_lock = threading.Lock()
_cache = {"ts": 0.0, "strength": {}}
_TTL = 60  # 行业强度缓存 60 秒，避免重复拉行情


def _eastmoney_sector_fund():
    """best-effort：拉东财行业板块资金流，按名称归类到 sector，返回 {sector: 净流入亿}。"""
    try:
        url = ("https://push2.eastmoney.com/api/qt/clist/get?fs=m:90+t:2"
               "&fields=f12,f14,f3,f62&pn=1&pz=400")
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (compatible; stock-workbench/1.0)",
            "Referer": "https://quote.eastmoney.com"})
        with urllib.request.urlopen(req, timeout=8) as r:
            d = json.loads(r.read().decode("utf-8"))
        items = (d.get("data") or {}).get("diff") or []
        out = {"科技": 0.0, "医药": 0.0, "电力": 0.0}
        for x in items:
            name = x.get("f14") or ""
            net = (x.get("f62") or 0) / 1e8  # 亿元
            for sec, kws in _EASTMONEY_KEYWORDS.items():
                if any(k in name for k in kws):
                    out[sec] += net
                    break
        return out
    except Exception:
        return {}


def _compute_strength():
    """按 track（细分赛道）计算趋势；资金流按大类 sector 归类。"""
    all_codes = ip.pool_codes()
    rt = ds.fetch_realtime(all_codes) if all_codes else {}
    by_track = {}
    for p in ip._POOL:
        v = rt.get(p["code"])
        if not v or v.get("change_pct") is None:
            continue
        by_track.setdefault(p.get("track"), []).append(v["change_pct"])
    fund = _eastmoney_sector_fund()
    out = {}
    for t in ip.tracks():
        pcts = by_track.get(t, [])
        trend = round(sum(pcts) / len(pcts), 2) if pcts else 0.0
        up = [x for x in pcts if x > 0]
        up_ratio = round(len(up) / len(pcts), 2) if pcts else 0.0
        score = round(min(100.0, max(0.0, 50 + trend * 8)), 1)
        sec = next((p.get("sector") for p in ip._POOL if p.get("track") == t), None)
        out[t] = {"track": t, "sector": sec, "trend_pct": trend,
                  "up_ratio": up_ratio, "fund_net": fund.get(sec), "score": score}
    return out


def sector_strength(key=None):
    """返回赛道/大类强度。key 优先按 track 匹配，否则按大类 sector 聚合。"""
    with _lock:
        now = time.time()
        if now - _cache["ts"] < _TTL and _cache["strength"]:
            cache = _cache["strength"]
        else:
            cache = _compute_strength()
            _cache["ts"] = now
            _cache["strength"] = cache
    if key:
        if key in cache:
            return cache[key]
        # key 为大类 sector：聚合该 sector 下各 track 均值
        tracks_in = [t for t, v in cache.items() if v.get("sector") == key]
        if tracks_in:
            pcts = [cache[t]["trend_pct"] for t in tracks_in]
            trend = round(sum(pcts) / len(pcts), 2)
            fund = cache[tracks_in[0]].get("fund_net")
            return {"track": key, "sector": key, "trend_pct": trend,
                    "up_ratio": 0.0, "fund_net": fund,
                    "score": round(min(100.0, max(0.0, 50 + trend * 8)), 1)}
        return {"track": key, "sector": key, "trend_pct": 0.0,
                "up_ratio": 0.0, "fund_net": None, "score": 50.0}
    return cache


def all_sector_strength():
    """返回全部细分赛道强度字典（供前端展示全部赛道热力）。"""
    return sector_strength()
