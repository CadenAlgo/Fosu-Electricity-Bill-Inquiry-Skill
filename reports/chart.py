"""Dependency-free CSV export and SVG chart generation."""

from __future__ import annotations

import csv
import datetime as dt
import html
import re
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

from clients.electricity_client import Reading


def _date(item: Any) -> dt.date:
    value = item.get("date") if isinstance(item, Mapping) else getattr(item, "date", None)
    return value if isinstance(value, dt.date) else dt.date.fromisoformat(str(value))


def _decimal(item: Any, keys: Sequence[str]) -> Decimal | None:
    for key in keys:
        value = item.get(key) if isinstance(item, Mapping) else getattr(item, key, None)
        if value is None or value == "":
            continue
        try:
            text = re.sub(r"[^0-9.+-]", "", str(value))
            return Decimal(text) if text else None
        except (InvalidOperation, ValueError):
            continue
    return None


def write_csv(readings: Iterable[Reading], path: str | Path) -> Path:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["date", "value", "unit"])
        for reading in readings:
            writer.writerow([reading.date.isoformat(), str(reading.value), reading.unit])
    return target


def _ticks(maximum: Decimal) -> list[Decimal]:
    high = max(Decimal("1"), maximum)
    step = high / 4
    return [step * index for index in range(5)]


def write_combined_svg(
    used_items: Iterable[Any],
    buy_items: Iterable[Any],
    path: str | Path,
    title: str = "Electricity usage and purchase",
) -> Path:
    """Render usage as a blue line and purchase as red scatter points."""

    used = [(_date(item), _decimal(item, ("value", "usage"))) for item in used_items]
    bought = [(_date(item), _decimal(item, ("quantity", "value"))) for item in buy_items]
    used = sorted((point for point in used if point[1] is not None), key=lambda item: item[0])
    bought = sorted((point for point in bought if point[1] is not None), key=lambda item: item[0])
    if not used and not bought:
        raise ValueError("没有可绘图的数据")

    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)

    width, height, margin = 1100, 480, 72
    plot_left, plot_right = 92, width - 92
    plot_top, plot_bottom = 52, height - 64
    plot_width, plot_height = plot_right - plot_left, plot_bottom - plot_top
    dates = [item[0] for item in used + bought]
    first_date, last_date = min(dates), max(dates)
    date_span = max((last_date - first_date).days, 1)

    def x_for(value: dt.date) -> float:
        if len(dates) == 1:
            return plot_left + plot_width / 2
        return plot_left + ((value - first_date).days / date_span) * plot_width

    used_max = max((item[1] for item in used), default=Decimal("1"))
    buy_max = max((item[1] for item in bought), default=Decimal("1"))
    used_ticks = _ticks(used_max)
    buy_ticks = _ticks(buy_max)

    def y_for(value: Decimal, maximum: Decimal) -> float:
        return plot_bottom - (float(value) / float(max(Decimal("1"), maximum))) * plot_height

    line_points = " ".join(
        f"{x_for(date):.1f},{y_for(value, used_max):.1f}"
        for date, value in used
    )
    scatter_points = "".join(
        f'<circle cx="{x_for(date):.1f}" cy="{y_for(value, buy_max):.1f}" r="3.2" fill="#dc2626" fill-opacity="0.85" />'
        for date, value in bought
    )
    left_grid = "".join(
        f'<line x1="{plot_left}" y1="{y_for(value, used_max):.1f}" x2="{plot_right}" y2="{y_for(value, used_max):.1f}" stroke="#e5e7eb" stroke-width="1" />'
        f'<text x="{plot_left - 10}" y="{y_for(value, used_max) + 4:.1f}" text-anchor="end" font-size="11" fill="#1d4ed8">{value:.1f}</text>'
        for value in used_ticks
    )
    right_labels = "".join(
        f'<text x="{plot_right + 10}" y="{y_for(value, buy_max) + 4:.1f}" text-anchor="start" font-size="11" fill="#b91c1c">{value:.1f}</text>'
        for value in buy_ticks
    )

    label_dates = sorted(set(dates))
    if len(label_dates) <= 6:
        selected_dates = label_dates
    else:
        indexes = {0, len(label_dates) // 2, len(label_dates) - 1}
        selected_dates = [label_dates[index] for index in sorted(indexes)]
    date_labels = "".join(
        f'<text x="{x_for(value):.1f}" y="{height - 28}" text-anchor="middle" font-size="11" fill="#4b5563">{value.isoformat()}</text>'
        for value in selected_dates
    )
    safe_title = html.escape(title)
    line_element = (
        f'<polyline points="{line_points}" fill="none" stroke="#2563eb" stroke-width="2.5" stroke-linejoin="round" />'
        if used
        else ""
    )
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" role="img" aria-label="{safe_title}">
  <rect width="100%" height="100%" fill="#ffffff" />
  <text x="{plot_left}" y="28" font-size="19" font-family="sans-serif" fill="#111827">{safe_title}</text>
  <text x="{plot_right}" y="28" text-anchor="end" font-size="12" font-family="sans-serif" fill="#2563eb">— 用电量（左轴）</text>
  <text x="{plot_right}" y="46" text-anchor="end" font-size="12" font-family="sans-serif" fill="#dc2626">• 购电量（右轴）</text>
  {left_grid}
  {right_labels}
  <line x1="{plot_left}" y1="{plot_bottom}" x2="{plot_right}" y2="{plot_bottom}" stroke="#6b7280" stroke-width="1" />
  <line x1="{plot_left}" y1="{plot_top}" x2="{plot_left}" y2="{plot_bottom}" stroke="#2563eb" stroke-width="1.2" />
  <line x1="{plot_right}" y1="{plot_top}" x2="{plot_right}" y2="{plot_bottom}" stroke="#dc2626" stroke-width="1.2" />
  {line_element}
  {scatter_points}
  {date_labels}
</svg>
'''
    target.write_text(svg, encoding="utf-8")
    return target


def write_svg(
    readings: Iterable[Reading],
    path: str | Path,
    title: str = "Electricity usage",
) -> Path:
    return write_combined_svg(readings, [], path, title)


def summarize_records(
    used_items: Iterable[Any],
    buy_items: Iterable[Any],
    requested_start: dt.date | None = None,
    requested_end: dt.date | None = None,
) -> dict[str, Any]:
    used = [item for item in used_items]
    bought = [item for item in buy_items]
    used_values = [value for item in used if (value := _decimal(item, ("value", "usage"))) is not None]
    buy_values = [value for item in bought if (value := _decimal(item, ("quantity", "value"))) is not None]
    amounts = [value for item in bought if (value := _decimal(item, ("amount", "cost", "money"))) is not None]

    used_dates = [_date(item) for item in used]
    buy_dates = [_date(item) for item in bought]
    start = requested_start or min(used_dates + buy_dates) if used_dates or buy_dates else None
    end = requested_end or max(used_dates + buy_dates) if used_dates or buy_dates else None

    used_total = sum(used_values, Decimal("0"))
    buy_total = sum(buy_values, Decimal("0"))
    amount_total = sum(amounts, Decimal("0"))
    used_recorded_days = len(set(used_dates))
    buy_recorded_days = len(set(buy_dates))

    seasons: dict[str, dict[str, Any]] = {}
    for item in used:
        date = _date(item)
        value = _decimal(item, ("value", "usage"))
        if value is None:
            continue
        month = date.month
        season = "春季" if 3 <= month <= 5 else "夏季" if 6 <= month <= 8 else "秋季" if 9 <= month <= 11 else "冬季"
        entry = seasons.setdefault(season, {"total": Decimal("0"), "days": set()})
        entry["total"] += value
        entry["days"].add(date)
    season_summary = {
        name: {
            "total_kwh": round(float(entry["total"]), 3),
            "recorded_days": len(entry["days"]),
            "average_kwh_per_recorded_day": round(
                float(entry["total"] / max(len(entry["days"]), 1)), 3
            ),
        }
        for name, entry in sorted(seasons.items())
    }

    summary: dict[str, Any] = {
        "range": {
            "start": start.isoformat() if start else None,
            "end": end.isoformat() if end else None,
        },
        "used": {
            "total_kwh": round(float(used_total), 3),
            "recorded_days": used_recorded_days,
            "average_kwh_per_recorded_day": round(
                float(used_total / max(used_recorded_days, 1)), 3
            ),
        },
        "buy": {
            "total_kwh": round(float(buy_total), 3),
            "total_amount": round(float(amount_total), 3),
            "purchase_count": len(bought),
            "recorded_days": buy_recorded_days,
            "average_amount_per_recorded_day": round(
                float(amount_total / max(buy_recorded_days, 1)), 3
            ),
        },
        "seasonal_used": season_summary,
    }
    if start and end:
        calendar_days = (end - start).days + 1
        summary["range"]["calendar_days"] = calendar_days
        summary["used"]["average_kwh_per_calendar_day"] = round(
            float(used_total / max(calendar_days, 1)), 3
        )
    if buy_total > 0 and amount_total >= 0:
        summary["buy"]["average_amount_per_kwh"] = round(
            float(amount_total / buy_total), 3
        )
    return summary