@echo off
REM ============================================================
REM  一键启动 cpolar 内网穿透，把本地股票工作台(8723)映射到公网
REM  前置：1) 已安装 cpolar 并加入 PATH
REM        2) 已执行过一次  cpolar authtoken 你的token
REM        3) 本机 python server.py 正在运行
REM ============================================================
echo ============================================
echo   cpolar 内网穿透 - 股票工作台(端口 8723)
echo ============================================
echo  [前置检查] 请确保：
echo   1. 已安装 cpolar ( https://www.cpolar.com/download )
echo   2. 已登录过 token: cpolar authtoken 你的token
echo   3. 本机 python server.py 正在运行
echo.
echo   启动后下方会显示  https://xxxx.cpolar.io  公网地址
echo   手机用流量(4G/5G)浏览器打开该地址即可
echo   关闭此窗口 = 断开隧道
echo ============================================
pause
cpolar http 8723
pause
