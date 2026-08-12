"""新闻/公告 best-effort 抓取（个股快讯 + 简单情绪打分）。

设计原则：
- 零第三方依赖，只用标准库 urllib + ssl。
- 海外/受限网络可能拉不到 → 一律返回 status="unavailable"，不抛异常、不影响主流程。
- 情绪打分是关键词粗筛，仅作扫描因子的辅助参考，不构成投资建议。
"""

import json
import ssl
import urllib.request

_POS_WORDS = ["订单", "中标", "签约", "扩产", "利好", "大涨", "突破", "获批",
              "新技术", "研发", "增长", "回购", "增持", "合作", "中标"]
_NEG_WORDS = ["减持", "诉讼", "处罚", "亏损", "下滑", "停产", "风险", "警示",
              "下调", "违约", "退市", "利空", "降级"]


def _http_get(url, timeout=6):
    try:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "Mozilla/5.0",
                     "Referer": "https://finance.eastmoney.com"})
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
            return r.read().decode("utf-8", "replace")
    except Exception:
        return None


def stock_news(code, limit=6):
    """个股快讯/公告（东财）。失败返回 status=unavailable。"""
    code = (code or "").lower().replace("sh", "").replace("sz", "")
    url = ("https://np-anotice-stock.eastmoney.com/api/security/ann"
           "?sr=-1&page_size=%d&ann_type=0&client_source=web&stock_list=%s" % (limit, code))
    raw = _http_get(url)
    if not raw:
        return {"status": "unavailable", "headlines": []}
    try:
        data = json.loads(raw)
        items = (data.get("data") or {}).get("list") or []
        heads = []
        for it in items[:limit]:
            t = it.get("title") or it.get("notice_title") or ""
            if t:
                heads.append(t)
        return {"status": "ok" if heads else "empty", "headlines": heads}
    except Exception:
        return {"status": "unavailable", "headlines": []}


def news_sentiment(headlines):
    """粗粒度情绪分：-100(极空) ~ +100(极多)。命中正负词各 ±12。"""
    score = 0
    for h in (headlines or []):
        for w in _POS_WORDS:
            if w in h:
                score += 12
                break
        for w in _NEG_WORDS:
            if w in h:
                score -= 12
                break
    return max(-100, min(100, score))


def industry_news(sector, limit=6):
    """行业新闻 best-effort：按 sector 关键词搜东财快讯，返回 {status, score, headlines}。

    仅作扫描「行业新闻」因子的辅助参考；任何失败一律返回 status=unavailable，不抛异常。
    云端 Render 通常可达，本地受限网络会静默降级（不影响主流程）。
    """
    kws = {
        "科技": "半导体 芯片 AI 算力 科技",
        "医药": "医药 创新药 医疗器械 医疗",
        "电力": "电力 新能源 电网 储能 特高压",
    }.get(sector, sector or "")
    if not kws:
        return {"status": "unavailable", "score": 0, "headlines": []}
    import urllib.parse
    url = ("https://np-anotice-stock.eastmoney.com/api/security/ann"
           "?sr=-1&page_size=%d&ann_type=0&client_source=web&keyword=%s" % (limit, urllib.parse.quote(kws)))
    raw = _http_get(url, timeout=6)
    if not raw:
        return {"status": "unavailable", "score": 0, "headlines": []}
    try:
        data = json.loads(raw)
        items = (data.get("data") or {}).get("list") or []
        heads = []
        for it in items[:limit]:
            t = it.get("title") or it.get("notice_title") or ""
            if t:
                heads.append(t)
        score = news_sentiment(heads)
        return {"status": "ok" if heads else "empty", "score": score, "headlines": heads}
    except Exception:
        return {"status": "unavailable", "score": 0, "headlines": []}


def headlines_text(news_dict):
    """取前两条标题拼成展示文本（前端用）。"""
    if not news_dict or news_dict.get("status") != "ok":
        return None
    hs = news_dict.get("headlines") or []
    return "；".join(hs[:2]) if hs else None
