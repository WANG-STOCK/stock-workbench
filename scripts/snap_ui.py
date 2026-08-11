import subprocess, os, time, shutil

edge = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
ud = "/tmp/edge-pos-" + str(int(time.time()))
shutil.rmtree(ud, ignore_errors=True)
out = r"D:\workbuddy\2026-08-10-11-22-24\stock-workbench\持仓更新后界面.png"
url = "http://127.0.0.1:8723/?code=sh600105&name=永鼎股份"

# 删掉旧截图
try:
    os.remove(out)
except OSError:
    pass

cmd = [edge, "--headless=new", "--no-sandbox", "--disable-gpu",
       "--hide-scrollbars", "--window-size=1440,900",
       "--user-data-dir=" + ud,
       "--virtual-time-budget=25000",
       "--screenshot=" + out,
       url]
print("RUN:", " ".join(cmd[:5]) + " ...")
r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
print("rc:", r.returncode)
print("stderr:", r.stderr[-200:] if r.stderr else "")
time.sleep(3)
print("EXISTS:", os.path.exists(out), "size:", os.path.getsize(out) if os.path.exists(out) else "-")
