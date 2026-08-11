"""检查云端实际持仓"""
import urllib.request, json, ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

CLOUD = "https://wang-zhibiao-2026.onrender.com"
LOCAL = "http://127.0.0.1:8723"


def get(base, path):
    try:
        req = urllib.request.Request(base + path, headers={"User-Agent": "Mozilla/5.0"})
        kw = {"timeout": 12}
        if base.startswith("https"):
            kw["context"] = ctx
        with urllib.request.urlopen(req, **kw) as r:
            return r.status, r.read().decode("utf-8", "ignore")
    except Exception as e:
        return -1, str(e)[:200]


for label, base in [("云端", CLOUD), ("本地", LOCAL)]:
    print(f"\n=== {label} ({base}) ===")
    s, b = get(base, "/api/positions")
    print(f"GET /api/positions -> {s}")
    try:
        data = json.loads(b)
        if isinstance(data, list):
            for p in data:
                print(f"  - {p.get('code'):<10} {p.get('name','')[:14]:<14} {p.get('shares'):>8}股 @ {p.get('cost')}")
            print(f"  共 {len(data)} 只")
        else:
            print(f"  RAW: {b[:200]}")
    except Exception:
        print(f"  RAW: {b[:200]}")
