import urllib.request, json

BASE = "http://127.0.0.1:8723"


def call(method, path, data=None):
    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(BASE + path, data=body, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            return r.status, r.read().decode("utf-8", "ignore")
    except Exception as e:
        return -1, str(e)


# 1) 列出当前的
print("=== EXISTING ===")
s, b = call("GET", "/api/positions")
print(s, b[:300])

# 2) 清掉旧的 4 只
for code in ["sh600105", "sz002475", "sh588160", "sh588940"]:
    s, b = call("DELETE", "/api/positions?code=" + code)
    print("DEL", code, "->", s, b[:80])

# 3) POST 5 只新的（已含变化）
positions = [
    {"code": "sh600105", "name": "永鼎股份", "shares": 100, "cost": 229.81},
    {"code": "sz002475", "name": "立讯精密", "shares": 200, "cost": 55.63},
    {"code": "sh588160", "name": "科创新材料ETF南方", "shares": 29100, "cost": 1.1180},
    {"code": "sh600183", "name": "生益科技", "shares": 200, "cost": 135.30},
    {"code": "sh588940", "name": "科创50ETF富国", "shares": 100, "cost": 0.185},
]
for p in positions:
    s, b = call("POST", "/api/positions", p)
    print("POST", p["code"], "->", s, b[:60])

# 4) 验证
print("=== AFTER ===")
s, b = call("GET", "/api/positions")
print(s, b)
