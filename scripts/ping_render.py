"""ping Render 看是不是休眠"""
import urllib.request, ssl, time

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

URLS = [
    "https://wang-zhibiao-2026.onrender.com/",
    "https://wang-zhibiao-2026.onrender.com/api/positions",
    "https://wang-zhibiao-2026.onrender.com/api/config",
]


def hit(u):
    try:
        req = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"})
        t0 = time.time()
        with urllib.request.urlopen(req, timeout=20, context=ctx) as r:
            return r.status, int((time.time()-t0)*1000), r.read()[:120]
    except Exception as e:
        return -1, 0, str(e)[:160]


for i in range(6):
    for u in URLS:
        s, ms, body = hit(u)
        print(f"#{i+1} {u.split('//')[1][:42]:<44} -> {s} {ms}ms {body[:60]}")
    print("---")
    time.sleep(2)
