"""Configurable electricity client with a safe WebForms discovery probe.

The campus endpoint has changed over time, so this module does not hard-code
an unverified API contract. It accepts a JSON endpoint through the environment
and validates the response before returning readings.
"""

from __future__ import annotations

import calendar
import datetime as dt
import html
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from html.parser import HTMLParser
from typing import Any, Iterable


DEFAULT_WEB_URL = "http://10.10.60.223:8010/"


class ElectricityError(RuntimeError):
    """Base error for a failed or ambiguous electricity operation."""


class ConfigurationError(ElectricityError):
    """Raised when an endpoint or required configuration is missing."""


class ResponseFormatError(ElectricityError):
    """Raised when an endpoint response cannot be mapped to readings."""


@dataclass(frozen=True)
class DateRange:
    start: dt.date
    end: dt.date

    def as_params(self) -> dict[str, str]:
        return {"start": self.start.isoformat(), "end": self.end.isoformat()}


@dataclass(frozen=True)
class Reading:
    date: dt.date
    value: Decimal
    unit: str = "kWh"
    raw: dict[str, Any] | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "date": self.date.isoformat(),
            "value": str(self.value),
            "unit": self.unit,
        }


def _months_ago(end: dt.date, months: int) -> dt.date:
    total = end.year * 12 + end.month - 1 - months
    year, month_index = divmod(total, 12)
    month = month_index + 1
    day = min(end.day, calendar.monthrange(year, month)[1])
    return dt.date(year, month, day)


def build_range(preset: str, today: dt.date | None = None) -> DateRange:
    """Convert a user-facing preset into an inclusive date range."""

    end = today or dt.date.today()
    key = preset.lower().strip()
    if key in {"today", "今天"}:
        return DateRange(end, end)
    if key in {"yesterday", "昨天"}:
        day = end - dt.timedelta(days=1)
        return DateRange(day, day)
    if key in {"7d", "7", "week", "最近7天", "最近 7 天"}:
        return DateRange(end - dt.timedelta(days=6), end)
    if key in {"30d", "30", "month", "最近30天", "最近 30 天"}:
        return DateRange(end - dt.timedelta(days=29), end)
    for value in (3, 6):
        names = {f"{value}m", f"{value}个月", f"最近{value}个月"}
        if value == 6:
            names.update({"半年", "最近半年"})
        if key in names:
            return DateRange(_months_ago(end, value) + dt.timedelta(days=1), end)
    for value in (12, 24, 36, 48):
        year_count = value // 12
        names = {
            f"{value}m",
            f"{year_count}y",
            f"{year_count}年",
            f"最近{year_count}年",
        }
        if key in names:
            return DateRange(_months_ago(end, value) + dt.timedelta(days=1), end)
    if key == "6m":
        pass
    raise ValueError(f"不支持的查询范围: {preset}")


def _date_value(value: Any) -> dt.date | None:
    if value is None:
        return None
    if isinstance(value, (dt.datetime, dt.date)):
        return value.date() if isinstance(value, dt.datetime) else value
    text = str(value).strip()
    if text.endswith("Z"):
        text = text[:-1]
    text = text.replace("/", "-").replace("年", "-").replace("月", "-").replace("日", "")
    text = text.replace("T", " ").split(" ", 1)[0]
    if re.fullmatch(r"20\d{2}-\d{1,2}", text):
        try:
            year, month = (int(part) for part in text.split("-"))
            return dt.date(year, month, 1)
        except ValueError:
            return None
    for candidate in (text, text[:10]):
        try:
            return dt.date.fromisoformat(candidate)
        except ValueError:
            continue
    match = re.search(r"(20\d{2})[-年](\d{1,2})[-月](\d{1,2})", str(value))
    if match:
        return dt.date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
    return None


def _decimal_value(value: Any) -> Decimal | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        text = re.sub(r"[^0-9.+-]", "", str(value))
        return Decimal(text) if text else None
    except (InvalidOperation, ValueError):
        return None


def _records(payload: Any) -> Iterable[Any]:
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in ("data", "result", "results", "items", "records", "list", "rows"):
            if key in payload:
                value = payload[key]
                if isinstance(value, list):
                    return value
                if isinstance(value, dict):
                    nested = _records(value)
                    if nested:
                        return nested
        return [payload]
    return []


def parse_readings(payload: Any) -> list[Reading]:
    """Parse common JSON shapes and reject records without date/value."""

    date_keys = ("date", "day", "time", "timestamp", "recordDate", "DATE", "JYRQ")
    value_keys = ("value", "usage", "consumption", "used", "quantity", "electricity", "DL", "用电量")
    output: list[Reading] = []
    for record in _records(payload):
        if not isinstance(record, dict):
            continue
        date_value = next((record.get(key) for key in date_keys if record.get(key) is not None), None)
        usage_value = next((record.get(key) for key in value_keys if record.get(key) is not None), None)
        reading_date = _date_value(date_value)
        number = _decimal_value(usage_value)
        if reading_date is None or number is None:
            continue
        unit = str(record.get("unit") or record.get("UNIT") or "kWh")
        output.append(Reading(reading_date, number, unit, dict(record)))
    if not output:
        raise ResponseFormatError("接口返回成功，但没有识别到同时包含日期和用电量的记录")
    return sorted(output, key=lambda item: item.date)


class _PageProbe(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title = ""
        self.form_action = ""
        self.hidden: dict[str, str] = {}
        self.selects: list[dict[str, Any]] = []
        self._in_title = False
        self._current: dict[str, Any] | None = None
        self._current_option: dict[str, Any] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        data = dict(attrs)
        if tag == "title":
            self._in_title = True
        elif tag == "form" and not self.form_action:
            self.form_action = data.get("action") or ""
        elif tag == "input" and (data.get("type") or "").lower() == "hidden":
            if data.get("name"):
                self.hidden[data["name"]] = data.get("value") or ""
        elif tag == "select":
            self._current = {"id": data.get("id", ""), "name": data.get("name", ""), "options": []}
            self.selects.append(self._current)
        elif tag == "option" and self._current is not None:
            self._current_option = {"value": data.get("value", ""), "selected": "selected" in data, "text": ""}
            self._current["options"].append(self._current_option)

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self._in_title = False
        elif tag == "select":
            self._current = None
        elif tag == "option":
            self._current_option = None

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title += data
        if self._current_option is not None:
            self._current_option["text"] += data


def _probe_result(parser: _PageProbe, final_url: str, selected: dict[str, str] | None = None) -> dict[str, Any]:
    return {
        "url": final_url,
        "title": html.unescape(parser.title).strip(),
        "form_action": parser.form_action,
        "hidden_field_names": sorted(parser.hidden),
        "selects": parser.selects,
        "selected": selected or {},
        "note": "仅公开字段名和选项；未输出 ViewState、Cookie 或任何凭据。",
    }


def _read_page(opener: urllib.request.OpenerDirector, url: str, timeout: int) -> tuple[_PageProbe, str]:
    request = urllib.request.Request(url, headers={"User-Agent": "fosu-campus-agent/0.1"})
    with opener.open(request, timeout=timeout) as response:
        raw = response.read()
        charset = response.headers.get_content_charset() or "utf-8"
        body = raw.decode(charset, errors="replace")
        final_url = response.geturl()
    parser = _PageProbe()
    parser.feed(body)
    return parser, final_url


def _postback(
    opener: urllib.request.OpenerDirector,
    page_url: str,
    parser: _PageProbe,
    target: str,
    fields: dict[str, str],
    timeout: int,
) -> tuple[_PageProbe, str]:
    data = dict(parser.hidden)
    data.update({"__EVENTTARGET": target, "__EVENTARGUMENT": "", "__LASTFOCUS": ""})
    data.update(fields)
    action = urllib.parse.urljoin(page_url, parser.form_action or page_url)
    request = urllib.request.Request(
        action,
        data=urllib.parse.urlencode(data).encode("utf-8"),
        headers={"User-Agent": "fosu-campus-agent/0.1", "Content-Type": "application/x-www-form-urlencoded"},
    )
    with opener.open(request, timeout=timeout) as response:
        raw = response.read()
        charset = response.headers.get_content_charset() or "utf-8"
        body = raw.decode(charset, errors="replace")
        final_url = response.geturl()
    next_page = _PageProbe()
    next_page.feed(body)
    return next_page, final_url


def probe_webform(
    url: str = DEFAULT_WEB_URL,
    timeout: int = 20,
    building: str | None = None,
    floor: str | None = None,
) -> dict[str, Any]:
    """Inspect public form metadata and optional safe cascading postbacks."""

    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor())
    try:
        parser, final_url = _read_page(opener, url, timeout)
        selected: dict[str, str] = {}
        if building:
            parser, final_url = _postback(opener, final_url, parser, "drlouming", {"drlouming": building}, timeout)
            selected["building"] = building
        if floor:
            if not building:
                raise ElectricityError("指定 floor 时必须同时指定 building")
            parser, final_url = _postback(opener, final_url, parser, "drceng", {"drlouming": building, "drceng": floor}, timeout)
            selected["floor"] = floor
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise ElectricityError(f"无法访问电费页面 {url}: {exc}") from exc
    return _probe_result(parser, final_url, selected)


class ElectricityClient:
    def __init__(self, api_url: str | None = None, timeout: int = 20) -> None:
        self.api_url = api_url or os.getenv("FOSU_ELECTRICITY_API_URL", "").strip()
        self.timeout = timeout

    def query(self, date_range: DateRange) -> list[Reading]:
        if not self.api_url:
            raise ConfigurationError(
                "未配置可验证的电费 JSON 接口。先运行 electricity-probe，确认 Network 请求后设置 FOSU_ELECTRICITY_API_URL。"
            )
        params = date_range.as_params()
        extra = os.getenv("FOSU_ELECTRICITY_API_PARAMS_JSON", "").strip()
        if extra:
            try:
                extra_params = json.loads(extra)
                if not isinstance(extra_params, dict):
                    raise ValueError("必须是 JSON 对象")
                params.update({str(key): str(value) for key, value in extra_params.items()})
            except (json.JSONDecodeError, ValueError) as exc:
                raise ConfigurationError(f"FOSU_ELECTRICITY_API_PARAMS_JSON 无效: {exc}") from exc
        method = os.getenv("FOSU_ELECTRICITY_API_METHOD", "GET").strip().upper()
        if method not in {"GET", "POST"}:
            raise ConfigurationError("FOSU_ELECTRICITY_API_METHOD 只能是 GET 或 POST")
        query = urllib.parse.urlencode(params)
        separator = "&" if "?" in self.api_url else "?"
        headers = {"Accept": "application/json", "User-Agent": "fosu-campus-agent/0.1"}
        body = None
        request_url = self.api_url
        if method == "GET":
            request_url = f"{self.api_url}{separator}{query}"
        else:
            body = query.encode("utf-8")
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        request = urllib.request.Request(
            request_url,
            data=body,
            headers=headers,
            method=method,
        )
        extra_headers = os.getenv("FOSU_ELECTRICITY_HEADERS_JSON", "").strip()
        if extra_headers:
            try:
                parsed_headers = json.loads(extra_headers)
                if not isinstance(parsed_headers, dict):
                    raise ValueError("必须是 JSON 对象")
                request.headers.update({str(key): str(value) for key, value in parsed_headers.items()})
            except (json.JSONDecodeError, ValueError) as exc:
                raise ConfigurationError(f"FOSU_ELECTRICITY_HEADERS_JSON 无效: {exc}") from exc
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                raw = response.read()
                charset = response.headers.get_content_charset() or "utf-8"
                payload = json.loads(raw.decode(charset, errors="replace"))
        except urllib.error.HTTPError as exc:
            raise ElectricityError(f"电费接口返回 HTTP {exc.code}，请检查登录状态、参数或接口地址") from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise ElectricityError(f"电费接口访问失败: {exc}") from exc
        except json.JSONDecodeError as exc:
            raise ResponseFormatError("电费接口没有返回 JSON，不能把页面文本当作查询成功") from exc
        readings = parse_readings(payload)
        return [item for item in readings if date_range.start <= item.date <= date_range.end]
