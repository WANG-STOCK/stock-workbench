@echo off
cd /d "%~dp0"
echo 正在启动技术面股票工作台...
start "" http://127.0.0.1:8723
"C:/Users/MyPC/.workbuddy/binaries/python/versions/3.13.12/python.exe" server.py
pause
