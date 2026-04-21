#!/usr/bin/env python3
import argparse
import json
import os
import re
from pathlib import Path


def decode_cursor(cursor: str):
    if not cursor:
        return {"offset": 0}
    try:
        data = json.loads(cursor)
    except Exception:
        return {"offset": 0}
    if not isinstance(data, dict):
        return {"offset": 0}
    return {"offset": max(0, int(data.get("offset", 0)))}


def encode_cursor(offset: int):
    return json.dumps({"offset": max(0, int(offset))}, separators=(",", ":"))


def should_skip_hidden(parts):
    for segment in parts:
        if segment.startswith("."):
            return True
    return False


def iter_files(root_path: Path):
    for dirpath, _, filenames in os.walk(root_path):
        rel_dir = Path(dirpath).relative_to(root_path)
        if should_skip_hidden(rel_dir.parts):
            continue
        for filename in filenames:
            if filename.startswith("."):
                continue
            yield Path(dirpath) / filename


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--query", required=True)
    parser.add_argument("--cursor", default="")
    parser.add_argument("--page-size", type=int, default=100)
    parser.add_argument("--max-results", type=int, default=2000)
    parser.add_argument("--case-sensitive", action="store_true")
    parser.add_argument("--regex", action="store_true")
    args = parser.parse_args()

    root_path = Path(args.root).resolve()
    if not root_path.exists() or not root_path.is_dir():
        print(
            json.dumps(
                {"matches": [], "returned": 0, "hasMore": False, "nextCursor": None, "totalScanned": 0}
            )
        )
        return

    page_size = max(1, min(int(args.page_size or 100), 1000))
    max_results = max(1, min(int(args.max_results or 2000), 50000))
    cursor = decode_cursor(args.cursor)
    start_offset = cursor["offset"]

    flags = 0 if args.case_sensitive else re.IGNORECASE
    pattern = args.query if args.regex else re.escape(args.query)
    compiled = re.compile(pattern, flags=flags)

    matches = []
    total_scanned = 0
    has_more = False

    for file_path in iter_files(root_path):
        relative = file_path.relative_to(root_path).as_posix()
        try:
            with file_path.open("r", encoding="utf-8", errors="ignore") as handle:
                for idx, line in enumerate(handle, start=1):
                    if compiled.search(line) is None:
                        continue
                    total_scanned += 1
                    if total_scanned <= start_offset:
                        continue
                    if len(matches) >= page_size:
                        has_more = True
                        break
                    matches.append(
                        {
                            "relativePath": relative,
                            "line": idx,
                            "text": line.rstrip("\n"),
                        }
                    )
                    if total_scanned >= max_results:
                        has_more = True
                        break
            if has_more:
                break
        except Exception:
            continue

    next_cursor = encode_cursor(start_offset + len(matches)) if has_more else None
    print(
        json.dumps(
            {
                "matches": matches,
                "returned": len(matches),
                "hasMore": has_more,
                "nextCursor": next_cursor,
                "totalScanned": total_scanned,
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
