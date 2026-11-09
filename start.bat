@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist .venv (
    echo Первый запуск: создаю окружение и ставлю зависимости...
    python -m venv .venv || (echo Не найден Python. Установите Python 3.10+ с python.org & pause & exit /b 1)
    .venv\Scripts\python -m pip install --upgrade pip >nul
    .venv\Scripts\pip install -r requirements.txt || (pause & exit /b 1)
)
if not exist .env (
    copy .env.example .env >nul
    echo.
    echo  Создан файл .env. Откройте его в Блокноте, вставьте строку подключения Supabase
    echo  в DATABASE_URL, сохраните и запустите start.bat снова.
    echo.
    notepad .env
    pause
    exit /b 0
)
if exist .venv\.deps-v2 goto run
.venv\Scripts\pip install -q -r requirements.txt || (pause & exit /b 1)
echo ok> .venv\.deps-v2
:run
.venv\Scripts\python run.py %*
pause
