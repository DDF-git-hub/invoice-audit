@echo off
chcp 65001 >nul
title 发票审核台 - 一键打包
cd /d "%~dp0"
echo.
echo ==============================================
echo    发票审核台  一键打包（只需要运行一次）
echo ==============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [缺少 Node.js] 请先安装 Node.js 长期支持版（LTS），装好后重新双击本文件。
  echo 正在打开下载页面……
  start "" "https://nodejs.org/zh-cn/download"
  pause
  exit /b 1
)
for /f "tokens=1 delims=v." %%v in ('node -v') do set NODEMAJOR=%%v
if %NODEMAJOR% LSS 18 (
  echo [Node.js 版本太旧] 需要 18 或更高版本，请到 nodejs.org 安装最新的 LTS 版本。
  pause
  exit /b 1
)

rem 使用国内镜像，下载更快更稳
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/

echo [1/2] 正在下载依赖，第一次大约需要 3-5 分钟……
call npm install --registry=https://registry.npmmirror.com --no-audit --no-fund
if errorlevel 1 goto fail

echo.
echo [2/2] 正在生成 exe……
call npm run dist -- --publish never
if errorlevel 1 (
  echo.
  echo 带图标打包没成功，改用备用方式重新打包（exe 图标会是默认样式）……
  call npx electron-builder --win --x64 --publish never -c.win.signAndEditExecutable=false
  if errorlevel 1 goto fail
)

echo.
echo ==============================================
echo  完成！dist 文件夹里有两个文件：
echo   InvoiceAudit-Portable-版本号.exe   免安装版，双击直接用
echo   InvoiceAudit-Setup-版本号.exe      安装版，装好后会自动更新
echo ==============================================
start "" "%~dp0dist"
pause
exit /b 0

:fail
echo.
echo 打包失败。请把上面的报错截图发给开发人员。
pause
exit /b 1
