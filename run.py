"""Start the dashboard: python run.py [--port 8000] [--no-browser]"""
import argparse
import sys
import threading
import webbrowser

import uvicorn

from app.env import load_env


def main() -> None:
    parser = argparse.ArgumentParser(description="Optimizer Dashboard")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--no-browser", action="store_true", help="не открывать браузер")
    parser.add_argument("--reset-login", action="store_true",
                        help="сбросить логин и пароль входа к исходным и выйти")
    parser.add_argument("--import-sqlite", nargs="?", const="data/optimizer.db", default=None,
                        metavar="PATH", help="перенести данные из старой SQLite-базы и выйти")
    args = parser.parse_args()

    load_env()
    from app import db

    try:
        db.check_connection()
        db.init()  # create / upgrade tables
    except db.DatabaseNotConfigured as exc:
        print(f"\n  {exc}\n")
        sys.exit(1)
    except Exception as exc:  # noqa: BLE001
        print(f"\n  Не удалось подключиться к базе данных:\n  {type(exc).__name__}: {exc}\n"
              "  Проверьте DATABASE_URL в файле .env и доступ в интернет.\n")
        sys.exit(1)

    try:
        if args.import_sqlite is not None:
            from app.sqlite_import import import_sqlite
            import_sqlite(args.import_sqlite)
            return
        if args.reset_login:
            version = int(db.get_settings().get("auth_version") or 1)
            db.delete_settings(["auth_login", "auth_hash"])
            db.set_settings({"auth_version": version + 1})
            print("Логин и пароль сброшены к исходному мастер-паролю. Все сессии завершены.")
            return
    finally:
        db.close()  # the server opens its own connections

    url = f"http://{args.host}:{args.port}"
    if not args.no_browser:
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()
    print(f"\n  Optimizer Dashboard запущен: {url}\n  Остановить: Ctrl+C\n")
    uvicorn.run("app.main:app", host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
