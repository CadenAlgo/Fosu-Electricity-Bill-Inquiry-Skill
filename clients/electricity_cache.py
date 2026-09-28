"""Small local cache for read-only dormitory electricity records."""

from __future__ import annotations

import datetime as dt
import json
import re
from pathlib import Path
from typing import Any

from clients.electricity_client import DateRange


CACHE_VERSION = 3


def _date(value: str | dt.date) -> dt.date:
    return value if isinstance(value, dt.date) else dt.date.fromisoformat(str(value))


def canonical_room(value: str) -> tuple[str, dict[str, str]]:
    """Return a stable room key and metadata for supported room formats."""

    original = str(value or "").strip()
    compact = re.sub(r"[\s_-]", "", original)

    special = re.fullmatch(r"(国交|河滨)(\d{3})", compact)
    if special:
        building, room = special.groups()
        floor = room[0]
        maximum = 8 if building == "国交" else 6
        if not 1 <= int(floor) <= maximum:
            raise ValueError(f"{building}不存在{floor}层")
        metadata = {"input": original, "building": building, "floor": floor, "room": room}
        return f"{building}-{room}", metadata

    match = re.fullmatch(r"[dD](\d+)", compact)
    if not match:
        raise ValueError("宿舍号格式应类似 D7502、D20502、D131402、国交502 或 河滨502")

    digits = match.group(1)
    if len(digits) == 4:
        building_digits, room = digits[:-3], digits[-3:]
    elif len(digits) == 5:
        building_digits, room = digits[:-3], digits[-3:]
    elif digits.startswith("13") and len(digits) == 6:
        building_digits, room = "13", digits[2:]
    else:
        raise ValueError(
            "宿舍号格式不正确：D1-D9 使用 3 位房间号，D10-D41 使用 3 位房间号，"
            "D13 使用 4 位房间号（例如 D131402）"
        )

    building_number = int(building_digits)
    if not 1 <= building_number <= 41:
        raise ValueError(f"宿舍楼号必须在 D1 到 D41 范围内: D{building_digits}")
    if building_number == 13 and len(room) != 4:
        raise ValueError("D13 的宿舍号应使用四位房间号，例如 D131402")

    floor = room[:2] if len(room) == 4 else room[0]
    if int(floor) < 1:
        raise ValueError("宿舍号中的楼层无效")
    if building_number == 13 and int(floor) > 14:
        raise ValueError(f"D13 不存在 {floor} 层")

    building = f"D{building_number}"
    metadata = {"input": original, "building": building, "floor": floor, "room": room}
    return f"{building}-{room}", metadata


def empty_cache() -> dict[str, Any]:
    return {"version": CACHE_VERSION, "rooms": {}}


def load_cache(path: str | Path) -> dict[str, Any]:
    target = Path(path)
    if not target.exists():
        return empty_cache()
    try:
        data = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"电费缓存无法读取: {exc}") from exc
    if not isinstance(data, dict) or data.get("version") != CACHE_VERSION or not isinstance(data.get("rooms"), dict):
        raise ValueError("电费缓存版本不兼容，请删除缓存后重新查询")
    return data


def save_cache(path: str | Path, data: dict[str, Any]) -> Path:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + ".tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(target)
    return target


def _entry(room_data: dict[str, Any], kind: str) -> dict[str, Any]:
    records = room_data.setdefault("records", {})
    entry = records.setdefault(kind, {"covered": [], "items": []})
    if not isinstance(entry.get("covered"), list):
        entry["covered"] = []
    if not isinstance(entry.get("items"), list):
        entry["items"] = []
    return entry


def _intervals(room_data: dict[str, Any], kind: str) -> list[DateRange]:
    output: list[DateRange] = []
    for raw in _entry(room_data, kind).get("covered", []):
        try:
            output.append(DateRange(_date(raw["start"]), _date(raw["end"])))
        except (KeyError, TypeError, ValueError):
            continue
    return output


def _merge_intervals(intervals: list[DateRange]) -> list[DateRange]:
    if not intervals:
        return []
    ordered = sorted(intervals, key=lambda item: item.start)
    merged = [ordered[0]]
    for item in ordered[1:]:
        previous = merged[-1]
        if item.start <= previous.end + dt.timedelta(days=1):
            previous = DateRange(previous.start, max(previous.end, item.end))
            merged[-1] = previous
        else:
            merged.append(item)
    return merged


def missing_ranges(room_data: dict[str, Any], kind: str, requested: DateRange) -> list[DateRange]:
    """Return the parts of requested that are not covered by cached reads."""

    missing: list[DateRange] = []
    cursor = requested.start
    for covered in sorted(_intervals(room_data, kind), key=lambda item: item.start):
        if covered.end < cursor:
            continue
        if covered.start > cursor:
            missing.append(DateRange(cursor, min(requested.end, covered.start - dt.timedelta(days=1))))
        cursor = max(cursor, covered.end + dt.timedelta(days=1))
        if cursor > requested.end:
            break
    if cursor <= requested.end:
        missing.append(DateRange(cursor, requested.end))
    return missing


def _record_key(kind: str, record: dict[str, Any]) -> tuple[str, ...]:
    if kind == "buy":
        fields = ("date", "time", "meter", "quantity", "amount", "purchaser")
    else:
        fields = ("date", "meter", "usage", "price")
    return tuple(str(record.get(field, "")) for field in fields)


def merge_result(
    data: dict[str, Any],
    room_key: str,
    room_metadata: dict[str, str],
    kind: str,
    queried: DateRange,
    items: list[dict[str, Any]],
    remaining: float | None = None,
) -> None:
    room_data = data.setdefault("rooms", {}).setdefault(
        room_key, {"room": room_metadata, "records": {}}
    )
    room_data["room"] = room_metadata
    entry = _entry(room_data, kind)

    existing = {
        _record_key(kind, item): item
        for item in entry.get("items", [])
        if isinstance(item, dict) and item.get("date")
    }
    for item in items:
        if isinstance(item, dict) and item.get("date"):
            existing[_record_key(kind, item)] = item
    entry["items"] = sorted(
        existing.values(),
        key=lambda item: (_date(str(item["date"])), _record_key(kind, item)),
    )

    covered = _intervals(room_data, kind)
    covered.append(queried)
    entry["covered"] = [
        {"start": item.start.isoformat(), "end": item.end.isoformat()}
        for item in _merge_intervals(covered)
    ]

    if remaining is not None:
        room_data["remaining"] = remaining
    room_data["updated_at"] = dt.datetime.now(dt.timezone.utc).isoformat()


def items_for(data: dict[str, Any], room_key: str, kind: str, requested: DateRange) -> list[dict[str, Any]]:
    room_data = data.get("rooms", {}).get(room_key, {})
    entry = room_data.get("records", {}).get(kind, {})
    output = []
    for item in entry.get("items", []):
        try:
            item_date = _date(str(item["date"]))
        except (KeyError, TypeError, ValueError):
            continue
        if requested.start <= item_date <= requested.end:
            output.append(item)
    return output
