import json, urllib.request

def get(path):
    with urllib.request.urlopen("http://127.0.0.1:8723" + path, timeout=15) as r:
        return json.load(r)

print("=== 当前持仓（来自工作台 ledger）===")
for p in get("/api/positions"):
    print(f"  {p['code']} {p['name']:<10} {p['shares']:>5}股 @ {p['cost']:.2f}")

print("\n=== 每只持仓的信号与建议 ===")
for p in get("/api/positions"):
    code = p["code"]
    try:
        a = get(f"/api/advice?code={code}&capital=100000")
        pos = a["position"]
        print(f"\n  {p['name']} {code} · 现价 {a['price']}")
        print(f"    综合：{a['action']}  评分：{a['score']:+}")
        print(f"    持仓：{p['shares']} 股 @ {p['cost']:.2f}  现价值 {p['shares']*a['price']:,.0f}  浮盈 {(a['price']-p['cost'])*p['shares']:+,.0f}")
        print(f"    建议：{pos['suggestion']}")
        if pos.get("note"):
            print(f"    提示：{pos['note']}")
    except Exception as e:
        print(f"  {code}: 获取失败 {e}")
