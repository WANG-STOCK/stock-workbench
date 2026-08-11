# -*- coding: utf-8 -*-
"""
一键把本机持仓同步到云端 Render 工作台。
读取项目内 data/positions.json，逐只 POST 到云端的 /api/positions。
云端为全新实例，首次请求可能冷启动，已加重试与长超时。
"""
import json
import os
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
LOCAL_POS = os.path.join(HERE, "data", "positions.json")
# 云端固定链接（与后端 config.cloud_url 保持一致，改了这里也要同步改）
CLOUD = "https://wang-zhibiao-2026.onrender.com"


def load_local():
    if not os.path.isfile(LOCAL_POS):
        return []
    with open(LOCAL_POS, encoding="utf-8") as f:
        return json.load(f)


def post_one(rec, timeout=60):
    data = json.dumps(rec).encode("utf-8")
    req = urllib.request.Request(
        CLOUD + "/api/positions",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def main():
    recs = load_local()
    if not recs:
        print("本机 data/positions.json 没有持仓，无需同步。")
        return
    print(f"本机读到 {len(recs)} 只持仓，开始同步到云端 {CLOUD} ...")
    ok = 0
    for rec in recs:
        name = rec.get("name", "")
        code = rec.get("code", "")
        for attempt in range(1, 4):
            try:
                r = post_one(rec)
                if r.get("ok"):
                    print(f"  [OK] {name}({code}) 同步成功")
                    ok += 1
                    break
                else:
                    print(f"  [失败] {name}({code}) 返回异常: {r}")
                    break
            except urllib.error.HTTPError as e:
                print(f"  [失败] {name}({code}) HTTP {e.code}: {e.read().decode('utf-8', 'ignore')[:120]}")
                break
            except Exception as e:
                if attempt < 3:
                    print(f"  [重试 {attempt}] {name}({code}): {e}")
                    time.sleep(5)
                else:
                    print(f"  [失败] {name}({code}): {e}")
    print(f"\n完成：{ok}/{len(recs)} 只已同步到云端。")
    print(f"手机打开 {CLOUD} 即可看到您的持仓。")


if __name__ == "__main__":
    main()
