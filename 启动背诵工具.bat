@echo off
rem ============================================
rem  AI 英语背诵清单 - 一键启动
rem  引擎(8080) + 网页服务(8804), 全程本地离线
rem ============================================
setlocal
set BASE=C:\Users\krkld\.openclaw\projects\english-study
set APP=%BASE%\app
set MODEL=%BASE%\models\gemma-4-E2B-it-Q4_K_M.gguf
set MMPROJ=%BASE%\models\gemma-4-E2B-mmproj-F16.gguf
where node >nul 2>nul || (echo [错误] 未找到 node & pause & exit /b 1)

rem 1. 启动推理引擎 llama-server (8080), 已在跑则跳过
netstat -ano | findstr ":8080 " | findstr "LISTENING" >nul
if %errorlevel%==0 (
  echo [引擎] 8080 已在运行
) else (
  rem 显存检测: 空闲 <3.5GB 时降级 GPU 层数(防被 ComfyUI/其他任务挤崩)
  set NGL=99
  for /f "tokens=2 delims=," %%a in ('nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits') do set FREEGB=%%a
  if defined FREEGB (
    if %FREEGB% LSS 4500 (
      set NGL=25
      echo [引擎] 显存仅 %FREEGB%MB, 降级 GPU 层数(-ngl 25), 速度会变慢
    ) else (
      echo [引擎] 显存充足 (%FREEGB%MB), 全 GPU 加速
    )
  )
  echo [引擎] 启动 llama.cpp 推理引擎...
  start "llama-engine-8080" /min "%APP%\llama\llama-server.exe" -m "%MODEL%" --mmproj "%MMPROJ%" --host 127.0.0.1 --port 8080 -ngl %NGL% -c 8192 --jinja
  rem 等待引擎就绪(冷启动一般 4-30 秒, 首次含缓存编译可能更久)
  set /a n=0
  :wait_engine
  curl -s --max-time 2 http://127.0.0.1:8080/health | findstr "ok" >nul
  if %errorlevel%==0 goto engine_ok
  set /a n+=1
  if %n% gtr 90 ( echo [警告] 引擎等待超时, 继续尝试启动网页... & goto web_start )
  timeout /t 2 /nobreak >nul
  goto wait_engine
  :engine_ok
  echo [引擎] 就绪 (耗时约 %n% x2 秒)
)

:web_start
rem 2. 启动网页服务 (8804)
netstat -ano | findstr ":8804 " | findstr "LISTENING" >nul
if %errorlevel%==0 (
  echo [网页] 8804 已在运行
) else (
  echo [网页] 启动本地服务 http://127.0.0.1:8804
  start "english-study-8804" /min cmd /c "cd /d %APP% && node server.js"
  timeout /t 2 /nobreak >nul
)
start http://127.0.0.1:8804
echo [完成] 已打开: http://127.0.0.1:8804
endlocal
