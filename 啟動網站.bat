@echo off
cd /d "%~dp0"
echo ============================================
echo   Secret Chat - 一鍵啟動腳本
echo ============================================
echo.

echo [1/2] 正在編譯前端 (Building Frontend)...
cd frontend
call npm run build
if %errorlevel% neq 0 (
    echo.
    echo ❌ 前端編譯失敗！請檢查錯誤訊息。
    pause
    exit /b 1
)
echo ✅ 前端編譯完成！
echo.

echo [2/2] 正在啟動伺服器 (Starting Server)...
cd ..
node server.js

echo.
echo 伺服器已停止運作 (Server stopped).
pause
