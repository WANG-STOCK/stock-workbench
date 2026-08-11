"""演示：拿到持仓列表后，逐只拉信号 + 做T计划"""
import urllib.request, json

BASE = "http://127.0.0.1:8723"


def get(path):
    req = urllib.request.Request(BASE + path, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode("utf-8", "ignore"))


# 1) 当前持仓
positions = get("/api/positions")
print("\n=== 当前持仓（5 只）===")
print(f"{'代码':<12}{'名称':<18}{'股数':>10}{'成本':>10}")
for p in positions:
    name = p.get("name", "")[:14]
    print(f"{p['code']:<12}{name:<18}{p['shares']:>10}{p['cost']:>10}")

# 2) 实时信号
print("\n=== 每只的实时信号 + 做T计划 ===")
for p in positions:
    code = p["code"]
    try:
        sig = get(f"/api/signal?code={code}")
    except Exception as e:
        print(f"\n--- {code} {p.get('name','')} --- 错误: {e}")
        continue
    s = sig.get("summary", {})
    pl = sig.get("price_levels", {})
    tp = sig.get("t_plan") or {}
    print(f"\n--- {code} {p.get('name','')} （现价 {s.get('price', '--')}） ---")
    print(f"  技术分: {s.get('score', '--')}  动作: {s.get('action', '--')}  理由: {s.get('reason', '')[:60]}")
    print(f"  买价 {pl.get('buy', '--')}  卖价 {pl.get('sell', '--')}  支撑 {pl.get('support', '--')}  阻力 {pl.get('resist', '--')}")
    if tp.get("t_action"):
        print(f"  做T: {tp.get('t_action')} 低吸 {tp.get('t_buy_price')} 高抛 {tp.get('t_sell_price')} 量 {tp.get('t_qty')}")
        if tp.get("t_note"):
            print(f"  备注: {tp.get('t_note')}")
    # 持仓盈亏
    cur = s.get("price")
    if cur and p.get("cost") and p.get("shares"):
        diff = (cur - p["cost"]) * p["shares"]
        pct = (cur / p["cost"] - 1) * 100
        print(f"  持仓盈亏: {diff:+,.0f} 元 ({pct:+.2f}%)")
