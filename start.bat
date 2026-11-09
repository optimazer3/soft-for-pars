@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist .venv (
    echo Первый запуск: создаю окружение и ставлю зависимости...
    python -m venv .venv || (echo Не найден Python. Установите Python 3.10+ с python.org & pause & exit /b 1)
    .venv\Scripts\python -m pip install --upgrade pip >nul
    .venv\Scripts\pip install -r requirements.txt || (pause & exit /b 1)
)
.venv\Scripts\python run.py %*
pause
