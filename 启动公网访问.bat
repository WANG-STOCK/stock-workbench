@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================================
echo   股票工作台 · 手机公网访问（Cloudflare 隧道，免注册）
echo ------------------------------------------------------------
echo   作用：把本机 8723 端口暴露成一个公网网址，
echo         手机用任意网络（不同 WiFi / 流量）都能打开。
echo   说明：网址是临时的，关闭本窗口即失效；
echo         请勿外泄网址，仅自己使用（无登录鉴权）。
echo ============================================================
echo.

echo 正在启动工作台后端（若提示端口占用属正常，说明已在运行）...
start "" "C:/Users/MyPC/.workbuddy/binaries/python/versions/3.13.12/python.exe" server.py
timeout /t 3 >nul

powershell -Command "Unblock-File '%~dp0cloudflared.exe'" >nul 2>nul
echo.
echo 正在建立公网隧道，请稍候几秒...
echo 出现 https://xxxx.trycloudflare.com 后，复制它到手机浏览器打开即可。
echo （关闭此窗口 = 断开公网访问）
echo.

cloudflared.exe tunnel --url http://localhost:8723
pause
