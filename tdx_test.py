import urllib.request, json

def post(path, obj):
    data = json.dumps(obj).encode("utf-8")
    req = urllib.request.Request("http://127.0.0.1:8723" + path, data=data,
                                  headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=8) as r:
        return json.load(r)

# 1) current config
d = json.load(urllib.request.urlopen("http://127.0.0.1:8723/api/config", timeout=8))
print("current tdx_path=", repr(d["tdx_path"]), "available=", d["tdx_available"])

# 2) save an invalid path -> should report available=False
r = post("/api/config", {"tdx_path": "C:\\fake\\vipdoc"})
print("save fake ->", r)

# 3) reset to empty
r = post("/api/config", {"tdx_path": ""})
print("reset ->", r)
