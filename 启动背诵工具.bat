@echo off
rem ============================================
rem  英语背诵与学习软件 (cat paw) · 一键启动
rem  引擎(8080) + 网页服务(8804), 全程本地离线
rem  首次运行: 自动检测运行前提; 缺少 AI 模型/引擎时可一键下载
rem ============================================
setlocal enabledelayedexpansion
set BASE=%~dp0
if "%BASE:~-1%"=="\" set BASE=%BASE:~0,-1%
set APP=%BASE%\app
set MODEL=%BASE%\models\gemma-4-E2B-it-Q4_K_M.gguf
set MMPROJ=%BASE%\models\gemma-4-E2B-mmproj-F16.gguf
set ENGINE=%APP%\llama\llama-server.exe

echo ============================================
echo   英语背诵与学习软件 (cat paw)
echo   目录: %BASE%
echo ============================================
echo.

rem ---------- 0a. 运行前提: Node.js ----------
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js ^(本软件服务端需要 Node.js 18 或更高版本^)
  echo        下载安装: https://nodejs.org/zh-cn/download
  echo        安装完成后重新双击本文件即可。
  echo.
  pause
  exit /b 1
)

rem ---------- 0b. 运行前提: AI 模型与引擎 ----------
set HAVE_AI=1
if not exist "%ENGINE%" set HAVE_AI=0
if not exist "%MODEL%"  set HAVE_AI=0
if not exist "%MMPROJ%" set HAVE_AI=0

if "%HAVE_AI%"=="0" (
  echo [提示] 未检测到 AI 模型与推理引擎 ^(约 5.2 GB^)
  echo.
  echo        缺少它们时仍可使用: 界面 · 词书浏览 · 默写 · 记忆复习
  echo        不可使用:           课文提炼 · 图片/PDF 识别
  echo.
  echo   [1] 现在下载 AI ^(推荐: 约 5.2 GB, 支持断点续传 + sha256 校验^)
  echo   [2] 先不下载, 以"最小版"启动 ^(界面/词书/默写可用^)
  echo   [3] 退出
  echo.
  set /p CHOICE=请输入 1 或 2 或 3 后回车:
  if "!CHOICE!"=="1" (
    echo.
    set PSMISS=0
    if not exist "%BASE%\tools\fetch-engine.ps1" set PSMISS=1
    if not exist "%BASE%\tools\fetch-models.ps1" set PSMISS=1
    if "!PSMISS!"=="1" (
      echo [错误] 缺少下载脚本, 无法自动下载 AI 组件:
      echo          tools\fetch-engine.ps1
      echo          tools\fetch-models.ps1
      echo        多半是解压不完整, 或被杀毒软件删除。
      echo        请重新完整解压后再试^(注意: 别在压缩软件预览窗口里直接运行^)。
      echo        现以"最小版"启动。
    ) else (
      echo [下载 1/2] 推理引擎 llama.cpp ...
      powershell -ExecutionPolicy Bypass -File "%BASE%\tools\fetch-engine.ps1"
      echo [下载 2/2] 模型权重 ^(约 3.9 GB^) ...
      powershell -ExecutionPolicy Bypass -File "%BASE%\tools\fetch-models.ps1"
      set HAVE_AI=1
      if not exist "%ENGINE%" set HAVE_AI=0
      if not exist "%MODEL%"  set HAVE_AI=0
      if not exist "%MMPROJ%" set HAVE_AI=0
      if "!HAVE_AI!"=="1" (
        echo [下载] 完成, 继续启动。
      ) else (
        echo [提示] 仍有文件缺失^(可能是网络中断^)。稍后可重跑:
        echo          powershell -ExecutionPolicy Bypass -File tools\fetch-models.ps1
        echo        现以"最小版"启动。
      )
    )
    echo.
  )
  if "!CHOICE!"=="3" (
    endlocal
    exit /b 0
  )
)

rem ---------- 1. 推理引擎 (8080) ----------
if "%HAVE_AI%"=="1" (
  netstat -ano | findstr ":8080 " | findstr "LISTENING" >nul
  if errorlevel 1 (
    set NGL=99
    for /f "tokens=2 delims=," %%a in ('nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits 2^>nul') do set FREEGB=%%a
    if defined FREEGB (
      if !FREEGB! LSS 4500 (
        set NGL=25
        echo [引擎] 显存仅 !FREEGB!MB, 降级 GPU 层数 ^(-ngl 25^), 速度会变慢
      ) else (
        echo [引擎] 显存充足 ^(!FREEGB!MB^), 全 GPU 加速
      )
    )
    echo [引擎] 启动 llama.cpp 推理引擎 ...
    start "llama-engine-8080" /min "%ENGINE%" -m "%MODEL%" --mmproj "%MMPROJ%" --host 127.0.0.1 --port 8080 -ngl !NGL! -c 8192 --jinja
    set /a n=0
    :wait_engine
    curl -s --max-time 2 http://127.0.0.1:8080/health | findstr "ok" >nul
    if not errorlevel 1 goto engine_ok
    set /a n+=1
    if !n! gtr 90 ( echo [警告] 引擎等待超时, 继续启动网页 ... & goto web_start )
    timeout /t 2 /nobreak >nul
    goto wait_engine
    :engine_ok
    echo [引擎] 就绪
  ) else (
    echo [引擎] 8080 已在运行
  )
) else (
  echo [引擎] 已跳过 ^(未安装 AI^) —— 界面/词书/默写可用, 提炼与图片识别不可用
)

:web_start
rem ---------- 2. 网页服务 (8804) ----------
netstat -ano | findstr ":8804 " | findstr "LISTENING" >nul
if errorlevel 1 (
  echo [网页] 启动本地服务 http://127.0.0.1:8804
  start "english-study-8804" /min /d "%APP%" cmd /c "node server.js"
) else (
  echo [网页] 8804 已在运行
)

rem ---- 关键: 必须等网页服务真的开始监听, 再开浏览器 (最多 30 秒) ----
set /a WN=0
:web_wait
netstat -ano | findstr ":8804 " | findstr "LISTENING" >nul
if not errorlevel 1 goto web_ready
set /a WN+=1
if !WN! gtr 30 goto web_fail
ping -n 2 127.0.0.1 >nul 2>nul
goto web_wait

:web_ready
start http://127.0.0.1:8804
echo.
echo [完成] 已打开: http://127.0.0.1:8804
echo        停止: 关闭弹出的两个窗口^(引擎/服务^), 或在此按任意键退出本窗口。
pause >nul
endlocal
exit /b 0

:web_fail
echo.
echo [错误] 网页服务没有起来 ^(http://127.0.0.1:8804 拒绝连接^)。
echo.
echo   请按顺序排查:
echo     1^) 你是不是在"压缩软件的临时目录"里直接运行的?
echo        当前目录: %BASE%
echo        若在 Temp / AweZip 之类目录下, 文件随时会被清掉。
echo        请把整个文件夹**完整解压**到硬盘^(如 D:\cat-paw-english^)再双击本文件。
echo     2^) 杀毒软件可能拦截或删除了文件。检查隔离区, 或把本文件夹加入白名单。
echo     3^) 手动看真实报错: 打开 cmd 依次执行
echo          cd /d "%APP%"
echo          node server.js
echo        把打印出来的错误发给作者。
echo.
pause
endlocal
exit /b 1
