"""基本面评分：质量档（人工精选标注）+ 实时估值（PE/PB，best-effort 容错）。

说明：
- 质量档 grade 来自行业池（A/B/C），是「研究结论」而非实时抓取，稳定可控。
- 实时估值从东财公开接口取 PE/PB 做小幅微调；任何失败都静默降级（不影响主流程）。
- 候选扫描的综合分 = 技术面 55% + 基本面 45%。
"""

import json
import time
import urllib.request

GRADE_BASE = {"A": 85.0, "B": 68.0, "C": 48.0}


def _secid(code):
    if code.startswith("sh"):
        return "1." + code[2:]
    if code.startswith("sz"):
        return "0." + code[2:]
    return None


def fetch_valuation(code, timeout=8):
    """取单只股票 PE/PB（东财公开接口）。失败返回 None。"""
    sid = _secid(code)
    if not sid:
        return None
    url = "https://push2.eastmoney.com/api/qt/stock/get?secid=%s&fields=f9,f23&fltt=2" % sid
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0",
            "Referer": "https://quote.eastmoney.com/",
        })
        with urllib.request.urlopen(req, timeout=timeout) as r:
            d = json.loads(r.read().decode("utf-8", "ignore"))
        data = d.get("data") or {}
        raw_pe = data.get("f9")
        raw_pb = data.get("f23")

        def _num(v):
            try:
                if v in (None, "-", "--", ""):
                    return None
                return float(v)
            except Exception:
                return None

        pe = _num(raw_pe)
        pb = _num(raw_pb)
        if pe is None and pb is None:
            return None
        return {"pe": pe, "pb": pb}
    except Exception:
        return None


def batch_valuation(codes, delay=0.04):
    """批量取估值，逐只容错，返回 {code: {pe, pb}}。"""
    out = {}
    for c in codes:
        try:
            v = fetch_valuation(c)
            if v:
                out[c] = v
        except Exception:
            pass
        time.sleep(delay)
    return out


def fundamental_score(grade, valuation=None):
    """基本面评分 0-100。质量档为基准，估值做小幅微调。"""
    base = GRADE_BASE.get(grade, 68.0)
    if isinstance(valuation, dict):
        pe = valuation.get("pe")
        if pe is not None:
            if 0 < pe <= 60:
                base += 3.0          # 估值合理，加分
            elif pe > 100:
                base -= 5.0          # 偏高，减分
            elif pe <= 0:
                base -= 8.0          # 亏损，减分
    return max(0.0, min(100.0, base))
