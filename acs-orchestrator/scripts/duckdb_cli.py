#!/usr/bin/env python3
"""Small DuckDB CLI wrapper for ACS sandboxes.

It intentionally covers the non-interactive subset used by ky-data-query:
  duckdb --version
  duckdb [-json] [-c SQL]
  duckdb [-json] [-c ".read path/to/query.sql"]
  duckdb [-json] [dbfile] < query.sql
"""

from __future__ import annotations

import json
import shlex
import sys
from pathlib import Path
from typing import Any


def main(argv: list[str]) -> int:
    try:
        import duckdb
    except ModuleNotFoundError:
        print(
            "duckdb Python package is not installed in the active runtime venv",
            file=sys.stderr,
        )
        return 127

    if any(arg in ("--version", "-version", "-v") for arg in argv):
        print(f"DuckDB {duckdb.__version__}")
        return 0

    json_mode = False
    command: str | None = None
    db_path = ":memory:"
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "-json":
            json_mode = True
        elif arg == "-c":
            i += 1
            if i >= len(argv):
                print("duckdb: -c requires a SQL argument", file=sys.stderr)
                return 2
            command = argv[i]
        elif arg.startswith("-c") and len(arg) > 2:
            command = arg[2:]
        elif arg.startswith("-"):
            print(f"duckdb: unsupported option: {arg}", file=sys.stderr)
            return 2
        elif db_path == ":memory:":
            db_path = arg
        else:
            print(f"duckdb: unexpected argument: {arg}", file=sys.stderr)
            return 2
        i += 1

    if not command:
        if sys.stdin.isatty():
            print("duckdb: interactive mode is not available in this runtime", file=sys.stderr)
            print("usage: duckdb [-json] [-c SQL] [dbfile] < query.sql", file=sys.stderr)
            return 2
        command = sys.stdin.read()
        if not command.strip():
            print("duckdb: stdin did not contain SQL", file=sys.stderr)
            return 2

    sql = expand_command(command)
    con = duckdb.connect(db_path)
    try:
        result = con.execute(sql)
        if result.description is None:
            return 0
        columns = [item[0] for item in result.description]
        rows = result.fetchall()
    finally:
        con.close()

    if json_mode:
        payload = [dict(zip(columns, row)) for row in rows]
        print(json.dumps(payload, ensure_ascii=False, default=str))
    else:
        print_tsv(columns, rows)
    return 0


def expand_command(command: str) -> str:
    stripped = command.strip()
    if not stripped.startswith(".read"):
        return command

    parts = shlex.split(stripped)
    if len(parts) != 2 or parts[0] != ".read":
        raise SystemExit("duckdb: expected .read <sql-file>")
    return Path(parts[1]).read_text(encoding="utf-8")


def print_tsv(columns: list[str], rows: list[tuple[Any, ...]]) -> None:
    print("\t".join(columns))
    for row in rows:
        print("\t".join(format_value(value) for value in row))


def format_value(value: Any) -> str:
    if value is None:
        return "NULL"
    return str(value)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
