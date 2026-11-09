"""Start the dashboard: python run.py [--port 8000] [--no-browser]"""
import argparse
import threading
import webbrowser

import uvicorn


def main() -> None:
    parser = argparse.ArgumentParser(description="Optimizer Dashboard")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--no-browser", action="store_true", help="не открывать браузер")
    parser.add_argument("--reset-login", action="store_true",
                        help="сбросить логин и пароль входа к исходным и выйти")
    args = parser.parse_args()

    if args.reset_login:
        from app import db
        db.execute("DELETE FROM settings WHERE key IN ('auth_login', 'auth_hash')")
        db.execute("UPDATE settings SET value = CAST(value AS INTEGER) + 1 WHERE key = 'auth_version'")
        print("Логин и пароль сброшены к исходному мастер-паролю. Все сессии завершены.")
        return

    url = f"http://{args.host}:{args.port}"
    if not args.no_browser:
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()
    print(f"\n  Optimizer Dashboard запущен: {url}\n  Остановить: Ctrl+C\n")
    uvicorn.run("app.main:app", host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
