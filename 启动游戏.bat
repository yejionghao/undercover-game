@echo off
chcp 65001 >nul
title 潜伏猜词 - 游戏服务器

echo.
echo  ==========================================
echo   🕵️  潜伏猜词 游戏服务器
echo  ==========================================
echo.

:: 检查 Node.js 是否安装
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  ❌ 未检测到 Node.js，请先安装：
    echo     https://nodejs.org/zh-cn/download
    echo.
    pause
    exit /b 1
)

:: 获取本机局域网 IP
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /i "IPv4" ^| findstr /v "127.0.0.1"') do (
    set LAN_IP=%%a
    goto :found_ip
)
:found_ip
set LAN_IP=%LAN_IP: =%

:: 进入脚本所在目录
cd /d "%~dp0"

:: 安装依赖（如果 node_modules 不存在）
if not exist "node_modules" (
    echo  📦 首次运行，安装依赖中...
    npm install
    echo.
)

echo  ✅ 服务启动中...
echo.
echo  ─────────────────────────────────────────
echo   本机访问：http://localhost:3000
echo   局域网访问：http://%LAN_IP%:3000
echo  ─────────────────────────────────────────
echo.
echo   把上面的局域网地址发给同事，他们用手机/电脑浏览器打开即可
echo   关闭此窗口 = 停止游戏服务器
echo.

:: 启动服务（不使用 Redis，纯内存模式）
set NODE_ENV=production
node server.js

echo.
echo  服务已停止。
pause
