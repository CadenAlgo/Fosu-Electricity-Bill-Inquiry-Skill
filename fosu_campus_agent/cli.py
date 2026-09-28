from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import shutil
import subprocess
import sys
from decimal import Decimal
from pathlib import Path

from clients.electricity_client import DateRange, ElectricityClient, ElectricityError, Reading, build_range, probe_webform
from clients.electricity_cache import (
    CACHE_VERSION,
    canonical_room,
    empty_cache,
    items_for,
    load_cache,
    merge_result,
    missing_ranges,
    save_cache,
)
from reports.chart import summarize_records, write_combined_svg, write_csv, write_svg


ROOT = Path(__file__).resolve().parents[1]


def _node_runtime() -> str:
    configured = os.getenv("CODEX_NODE")
    if configured:
        return configured
    on_path = shutil.which("node")
    if on_path:
        return on_path
    candidates = [
        Path.home() / ".cache" / "codex-runtimes" / "codex-primary-runtime" / "dependencies" / "node" / "bin" / "node.exe",
        Path.home() / ".cache" / "codex-runtimes" / "codex-primary-runtime" / "dependencies" / "node" / "bin" / "node",
    ]
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    raise FileNotFoundError("找不到 Node.js。请设置 CODEX_NODE，或在 Codex 工作区使用内置运行时。")


def _items_in_range(items: list[dict[str, object]], requested: DateRange) -> list[dict[str, object]]:
    output: list[dict[str, object]] = []
    for item in items:
        try:
            item_date = dt.date.fromisoformat(str(item["date"])[:10])
        except (KeyError, TypeError, ValueError):
            continue
        if requested.start <= item_date <= requested.end:
            output.append(item)
    return output


def _result_metadata(records: dict[str, object]) -> dict[str, object]:
    counts = {kind: len(group.get("readings", [])) for kind, group in records.items()}
    dates: list[dt.date] = []
    for group in records.values():
        for item in group.get("readings", []):
            try:
                dates.append(dt.date.fromisoformat(str(item["date"])[:10]))
            except (KeyError, TypeError, ValueError):
                continue
    return {
        "record_counts": counts,
        "actual_record_range": {
            "start": min(dates).isoformat() if dates else None,
            "end": max(dates).isoformat() if dates else None,
        },
    }

def _cached_payload(
    requested: DateRange,
    room_key: str,
    room_metadata: dict[str, str],
    cache_data: dict[str, object],
    cache_path: Path,
    kinds: list[str],
    cache_hit: bool,
) -> dict[str, object]:
    room_data = cache_data.get("rooms", {}).get(room_key, {})
    records: dict[str, object] = {}
    used_items = items_for(cache_data, room_key, "used", requested) if "used" in kinds else []
    buy_items = items_for(cache_data, room_key, "buy", requested) if "buy" in kinds else []
    if "used" in kinds:
        records["used"] = {
            "record_type": "used",
            "readings": used_items,
            "covered": room_data.get("records", {}).get("used", {}).get("covered", []),
        }
    if "buy" in kinds:
        records["buy"] = {
            "record_type": "buy",
            "readings": buy_items,
            "covered": room_data.get("records", {}).get("buy", {}).get("covered", []),
        }
    return {
        "range": {"start": requested.start.isoformat(), "end": requested.end.isoformat()},
        "room": room_metadata,
        "remaining": room_data.get("remaining"),
        "cache": {
            "version": CACHE_VERSION,
            "hit": cache_hit,
            "file": str(cache_path),
            "updated_at": room_data.get("updated_at"),
        },
        "summary": summarize_records(used_items, buy_items, requested.start, requested.end),
        "records": records,
    }


def _electricity(args: argparse.Namespace) -> int:
    if args.browser or args.room:
        return _electricity_browser(args)
    try:
        date_range = build_range(args.preset, dt.date.fromisoformat(args.today) if args.today else None)
        readings = ElectricityClient(api_url=args.api_url).query(date_range)
    except (ValueError, ElectricityError) as exc:
        print(f"电费查询未完成: {exc}", file=sys.stderr)
        return 2
    if not readings:
        print("接口返回成功，但指定范围内没有数据。")
        return 1
    print(json.dumps([item.as_dict() for item in readings], ensure_ascii=False, indent=2))
    if args.csv:
        print(f"CSV: {write_csv(readings, args.csv)}")
    if args.chart:
        print(f"SVG: {write_svg(readings, args.chart, f'Electricity {args.preset}')}")
    return 0


def _electricity_browser(args: argparse.Namespace) -> int:
    try:
        runtime = _node_runtime()
        if args.start and args.end:
            requested = DateRange(dt.date.fromisoformat(args.start), dt.date.fromisoformat(args.end))
        elif args.start or args.end:
            raise ValueError("--start 和 --end 必须同时提供")
        else:
            requested = build_range(args.preset, dt.date.fromisoformat(args.today) if args.today else None)
        if requested.start > requested.end:
            raise ValueError("开始日期不能晚于结束日期")
        kinds = ["used", "buy"] if args.record_type == "both" else [args.record_type]
        cache_path = Path(args.cache_file or ROOT / ".local" / "electricity-cache.json")
        room_key = ""
        room_metadata: dict[str, str] = {}
        cache_data: dict[str, object] = {}
        missing: dict[str, list[DateRange]] = {kind: [requested] for kind in kinds}
        cache_hit = False
        if args.room:
            room_key, room_metadata = canonical_room(args.room)
            cache_data = empty_cache() if args.no_cache else load_cache(cache_path)
            room_data = cache_data.get("rooms", {}).get(room_key, {})
            missing = {kind: missing_ranges(room_data, kind, requested) for kind in kinds}
            cache_hit = all(not ranges for ranges in missing.values())
            if cache_hit:
                payload = _cached_payload(
                    requested, room_key, room_metadata, cache_data, cache_path, kinds, True
                )
                print(json.dumps(payload, ensure_ascii=False, indent=2))
                if args.csv and payload["records"].get("used", {}).get("readings"):
                    converted = [
                        Reading(dt.date.fromisoformat(item["date"]), Decimal(item.get("value", item.get("usage", "0"))), item.get("unit", "度"))
                        for item in payload["records"]["used"]["readings"]
                    ]
                    print(f"CSV: {write_csv(converted, args.csv)}")
                if args.chart:
                    write_combined_svg(
                        payload["records"].get("used", {}).get("readings", []),
                        payload["records"].get("buy", {}).get("readings", []),
                        args.chart,
                        f'Electricity {room_key} {requested.start.isoformat()} to {requested.end.isoformat()}',
                    )
                    print(f"SVG: {args.chart}")
                return 0
    except (OSError, ValueError, KeyError) as exc:
        print(f"电费查询未完成: {exc}", file=sys.stderr)
        return 2

    flow = ROOT / "browser" / "electricity_flow.mjs"
    temp = ROOT / ".local" / "electricity-result.json"
    plan_path = ROOT / ".local" / "electricity-plan.json"
    temp.parent.mkdir(parents=True, exist_ok=True)
    try:
        plan_path.write_text(json.dumps({"ranges": {kind: [{"start": item.start.isoformat(), "end": item.end.isoformat()} for item in ranges] for kind, ranges in missing.items()}}, ensure_ascii=False), encoding="utf-8")
        command = [runtime, str(flow), "--output-json", str(temp), "--start", requested.start.isoformat(), "--end", requested.end.isoformat(), "--plan-json", str(plan_path)]
        if args.profile_dir:
            command.extend(["--profile-dir", args.profile_dir])
        if args.browser_channel:
            command.extend(["--browser-channel", args.browser_channel])
        if args.room:
            command.extend(["--room", args.room])
        if args.record_type:
            command.extend(["--record-type", args.record_type])
        result = subprocess.run(command, check=False)
        if result.returncode != 0 or not temp.exists():
            return result.returncode or 2
        raw = json.loads(temp.read_text(encoding="utf-8"))
        if args.room:
            records = raw.get("records") or {}
            for kind in kinds:
                query_result = records.get(kind, {})
                queried_ranges = query_result.get("queries") or missing.get(kind, [])
                for item in queried_ranges:
                    queried = DateRange(dt.date.fromisoformat(item["start"]), dt.date.fromisoformat(item["end"]))
                    merge_result(
                        cache_data,
                        room_key,
                        room_metadata,
                        kind,
                        queried,
                        _items_in_range(query_result.get("readings", []), queried),
                    )
            remaining = raw.get("remaining")
            if remaining is not None and room_key:
                cache_data.setdefault("rooms", {}).setdefault(room_key, {})["remaining"] = remaining
            if not args.no_cache:
                save_cache(cache_path, cache_data)
            payload = _cached_payload(
                requested, room_key, room_metadata, cache_data, cache_path, kinds, False
            )
            payload["cache"]["fresh_ranges"] = {
                kind: [{"start": item.start.isoformat(), "end": item.end.isoformat()} for item in ranges]
                for kind, ranges in missing.items()
            }
        else:
            records = raw.get("records") or {}
            if not records and raw.get("readings") is not None:
                records = {"used": {"record_type": "used", "readings": raw.get("readings", [])}}
            payload = {
                "range": raw.get("range"),
                "room": raw.get("room"),
                "remaining": raw.get("remaining"),
                "records": records,
            }
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        if args.room:
            used_items = payload["records"].get("used", {}).get("readings", [])
            buy_items = payload["records"].get("buy", {}).get("readings", [])
            if args.csv and used_items:
                converted = [
                    Reading(dt.date.fromisoformat(item["date"]), Decimal(item.get("value", item.get("usage", "0"))), item.get("unit", "度"))
                    for item in used_items
                ]
                print(f"CSV: {write_csv(converted, args.csv)}")
            if args.chart:
                write_combined_svg(
                    used_items,
                    buy_items,
                    args.chart,
                    f'Electricity {room_key} {requested.start.isoformat()} to {requested.end.isoformat()}',
                )
                print(f"SVG: {args.chart}")
        else:
            used_items = records.get("used", {}).get("readings", [])
            converted = [
                Reading(dt.date.fromisoformat(item["date"]), Decimal(item.get("value", item.get("usage", "0"))), item.get("unit", "度"))
                for item in used_items
            ]
            if args.csv and converted:
                print(f"CSV: {write_csv(converted, args.csv)}")
            if args.chart and converted:
                print(f"SVG: {write_svg(converted, args.chart, f'Electricity {args.preset}')}")
        return 0
    except (OSError, json.JSONDecodeError, KeyError, ValueError) as exc:
        print(f"电费浏览器结果无法读取: {exc}", file=sys.stderr)
        return 2

def _probe(args: argparse.Namespace) -> int:
    try:
        result = probe_webform(args.url, building=args.building, floor=args.floor)
    except ElectricityError as exc:
        print(f"电费页面探测失败: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(prog="fosu-campus-agent")
    sub = parser.add_subparsers(dest="command", required=True)

    electricity = sub.add_parser("electricity", help="查询已配置接口的电费数据")
    electricity.add_argument("--preset", choices=["today", "yesterday", "7d", "30d", "3m", "6m", "1y", "2y", "3y", "4y"], default="30d")
    electricity.add_argument("--start", help="开始日期，格式 YYYY-MM-DD；和 --end 一起使用")
    electricity.add_argument("--end", help="结束日期，格式 YYYY-MM-DD；和 --start 一起使用")
    electricity.add_argument("--cache-file", help="本地电费缓存 JSON 路径；默认 .local/electricity-cache.json")
    electricity.add_argument("--no-cache", action="store_true", help="不读取也不写入本地缓存")
    electricity.add_argument("--today", help="测试用日期，格式 YYYY-MM-DD")
    electricity.add_argument("--api-url")
    electricity.add_argument("--csv")
    electricity.add_argument("--chart")
    electricity.add_argument("--browser", action="store_true", help="使用持久化浏览器会话查询真实 WebForms 页面")
    electricity.add_argument("--profile-dir")
    electricity.add_argument("--browser-channel", choices=["auto", "chrome", "msedge"], help="备用命令行浏览器；默认按 Chrome、Edge 尝试")
    electricity.add_argument("--room", help="公开查询宿舍号，例如 D7502、D7-502；提供后无需账号密码")
    electricity.add_argument("--record-type", choices=["used", "buy", "both"], default="used", help="查询用电记录、购电记录或两者")
    electricity.set_defaults(func=_electricity)

    probe = sub.add_parser("electricity-probe", help="探测公开 WebForms 页面，不提交凭据")
    probe.add_argument("--url", default="http://10.10.60.223:8010/")
    probe.add_argument("--building", help="安全地回发楼栋值并读取楼层选项")
    probe.add_argument("--floor", help="在指定楼栋后安全地回发楼层值并读取房间选项")
    probe.set_defaults(func=_probe)
    return args_func(parser.parse_args())


def args_func(args: argparse.Namespace) -> int:
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
