@echo off
rem ── Splat Analyzer dev environment ──
rem Run this INSIDE "x64 Native Tools Command Prompt for VS 2022"
cd /d C:\Users\anlan\GitHub\splat_analyzer
call .venv\Scripts\activate.bat
set TORCH_CUDA_ARCH_LIST=8.9
echo.
echo [dev.cmd] venv active, TORCH_CUDA_ARCH_LIST=8.9 — ready.
echo [dev.cmd] run: python run_local.py --ply room.ply --prompt "chair, table, vase" --quality low
