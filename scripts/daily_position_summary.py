# -*- coding: utf-8 -*-
"""持仓每日提醒：盘前 9:15 运行，给王总持仓股出一份操作摘要（每天仅一条）。
后端固定地址：云端优先，失败回退本地。仅读取信号，不下单。
"""
import subprocess, json, sys, datetime

CLOUD = "https://wang-zhibiao-2026.onrender.com"
LOCAL = "http://127.0.0.1:8723"


def curl_json(url, timeout=90):
    try:
        r = subprocess.run(
            ["curl", "-s", "--max-time", str(timeout), "-w", "\n%{http_code}", url],
            capture_output=True, text=True, encoding='utf-8', errors='replace')  # utf-8/replace 避免 Windows gbk 解码子进程输出崩溃
        out = r.stdout
        if not out.strip():
            return None, "EMPTY"
        parts = out.rsplit("\n", 1)
        body = parts[0]
        code = parts[1] if len(parts) > 1 else ""
        if r.returncode != 0 or code in ("", "000"):
            return None, code or ("EXIT%d" % r.returncode)
        try:
            return json.loads(body), code
        except Exception:
            return None, "JSONERR"
    except Exception as e:
        return None, "ERR:%s" % e


def fmt_price(v):
    if v is None:
        return "—"
    try:
        return "%.2f" % float(v)
    except Exception:
        return "—"


def fmt_qty(v):
    try:
        iv = int(v)
    except Exception:
        return "—"
    if iv <= 0:
        return "—"
    return "%d" % iv


def reason_text(r):
    if isinstance(r, dict):
        return r.get("text") or r.get("reason") or ""
    if isinstance(r, str):
        return r
    return ""


def main():
    today = datetime.date.today().strftime("%Y-%m-%d")

    # 1) 选 BASE：云端优先，curl 失败回退本地
    base = CLOUD
    pos, code = curl_json(base + "/api/positions", timeout=30)
    if pos is None:
        base = LOCAL
        pos, code = curl_json(base + "/api/positions", timeout=20)
        if pos is None:
            print("今日无持仓记录，无需提醒")
            return
    if not isinstance(pos, list):
        # 兼容 {positions:[...]} 等包装
        if isinstance(pos, dict) and isinstance(pos.get("positions"), list):
            pos = pos["positions"]
        else:
            print("今日无持仓记录，无需提醒")
            return
    if len(pos) == 0:
        print("今日无持仓记录，无需提醒")
        return

    # 2) 可用资金
    cfg, _ = curl_json(base + "/api/config", timeout=30)
    capital = 100000
    warn_capital = False
    if isinstance(cfg, dict):
        c = cfg.get("available_capital")
        if c is not None:
            try:
                capital = float(c)
            except Exception:
                capital = 100000
        # 云端 available_capital 损坏（如显示 ¥60）时，回退账户默认 ¥100,000
        if capital <= 0 or capital < 1000:
            capital = 100000
            warn_capital = True

    # 3) 逐只信号
    rows = []
    failed = 0
    for p in pos:
        code = p.get("code")
        name = p.get("name", code)
        if not code:
            continue
        url = (base + "/api/signal?code=" + code +
               "&period=daily&limit=120&capital=" + str(capital))
        sig, _ = curl_json(url, timeout=90)
        if not isinstance(sig, dict) or not sig.get("ok"):
            failed += 1
            continue
        action = sig.get("action", "持有")
        price = sig.get("price")
        pos_obj = sig.get("position") or {}
        buy_price = pos_obj.get("buy_price")
        sell_price = pos_obj.get("sell_price")
        delta = pos_obj.get("delta_shares")
        reasons = sig.get("reasons") or []
        r1 = reason_text(reasons[0]) if len(reasons) > 0 else ""
        r2 = reason_text(reasons[1]) if len(reasons) > 1 else ""
        oneline = "；".join([x for x in [r1, r2] if x]) or "—"
        # 做T计划
        tp = sig.get("t_plan") or {}
        t_action = tp.get("t_action") or "持有不动"
        t_buy = tp.get("t_buy_price")
        t_sell = tp.get("t_sell_price")
        t_qty = tp.get("t_qty")
        t_note = tp.get("t_note") or ""
        rows.append({
            "code": code, "name": name, "action": action, "price": price,
            "buy": buy_price, "sell": sell_price, "delta": delta,
            "reason": oneline, "t_action": t_action, "t_buy": t_buy,
            "t_sell": t_sell, "t_qty": t_qty, "t_note": t_note,
        })

    if len(rows) == 0:
        print("今日无持仓记录，无需提醒")
        return

    # 4) 汇总输出
    out = []
    out.append("📊 持仓每日提醒（%s）　可用资金 ¥%s" %
               (today, format(int(round(capital)), ",")))
    out.append("—" * 30)
    for r in rows:
        if r["delta"] and int(r["delta"]) > 0:
            qty = "买%d股" % int(r["delta"])
        elif r["delta"] and int(r["delta"]) < 0:
            qty = "卖%d股" % (-int(r["delta"]))
        else:
            qty = "—"
        out.append("%s(%s) | 现价%s | %s | 买%s | 卖%s | %s | %s" %
                   (r["name"], r["code"], fmt_price(r["price"]), r["action"],
                    fmt_price(r["buy"]), fmt_price(r["sell"]), qty, r["reason"]))
    out.append("—" * 30)
    out.append("【做T提示】")
    for r in rows:
        out.append("%s(%s)：%s | 低吸%s | 高抛%s | 做T量%s | %s" %
                   (r["name"], r["code"], r["t_action"], fmt_price(r["t_buy"]),
                    fmt_price(r["t_sell"]), fmt_qty(r["t_qty"]), r["t_note"] or "—"))
    out.append("—" * 30)
    out.append("以上为技术面+行业趋势信号，非个性化投资建议，请以您券商端实际操作为准。")
    if warn_capital:
        out.append("⚠️ 云端可用资金读取异常（显示 ¥60），已按账户默认 ¥100,000 计算；请在网页端「设置」把可用资金改回正确值。")
    if failed > 0:
        out.append("%d 只信号获取失败" % failed)

    print("\n".join(out))


if __name__ == "__main__":
    main()
