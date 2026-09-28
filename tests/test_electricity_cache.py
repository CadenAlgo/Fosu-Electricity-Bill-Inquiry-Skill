import datetime as dt
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path

from clients.electricity_cache import (
    canonical_room,
    empty_cache,
    items_for,
    merge_result,
    missing_ranges,
)
from clients.electricity_client import DateRange
from reports.chart import summarize_records, write_combined_svg


class ElectricityCacheTests(unittest.TestCase):
    def test_canonical_room_formats(self):
        self.assertEqual(
            canonical_room("D7502"),
            ("D7-502", {"input": "D7502", "building": "D7", "floor": "5", "room": "502"}),
        )
        self.assertEqual(
            canonical_room("D20-502"),
            ("D20-502", {"input": "D20-502", "building": "D20", "floor": "5", "room": "502"}),
        )
        self.assertEqual(
            canonical_room("D131402"),
            ("D13-1402", {"input": "D131402", "building": "D13", "floor": "14", "room": "1402"}),
        )
        self.assertEqual(
            canonical_room("国交801"),
            ("国交-801", {"input": "国交801", "building": "国交", "floor": "8", "room": "801"}),
        )

    def test_rejects_invalid_rooms_and_floors(self):
        with self.assertRaises(ValueError):
            canonical_room("D42001")
        with self.assertRaises(ValueError):
            canonical_room("D13502")
        with self.assertRaises(ValueError):
            canonical_room("D131502")
        with self.assertRaises(ValueError):
            canonical_room("河滨701")
        with self.assertRaises(ValueError):
            canonical_room("宿舍")

    def test_missing_ranges_understands_disjoint_coverage(self):
        cache = empty_cache()
        room = cache["rooms"]["D7-502"] = {"room": {}, "records": {}}
        merge_result(
            cache,
            "D7-502",
            {},
            "used",
            DateRange(dt.date(2026, 1, 1), dt.date(2026, 1, 10)),
            [],
        )
        merge_result(
            cache,
            "D7-502",
            {},
            "used",
            DateRange(dt.date(2026, 1, 20), dt.date(2026, 1, 31)),
            [],
        )
        missing = missing_ranges(
            room,
            "used",
            DateRange(dt.date(2026, 1, 1), dt.date(2026, 1, 31)),
        )
        self.assertEqual(missing, [DateRange(dt.date(2026, 1, 11), dt.date(2026, 1, 19))])

    def test_merge_records_and_query_cached_items(self):
        cache = empty_cache()
        merge_result(
            cache,
            "D7-502",
            {"building": "D7", "floor": "5", "room": "502"},
            "used",
            DateRange(dt.date(2026, 9, 1), dt.date(2026, 9, 2)),
            [
                {"date": "2026-09-02", "meter": "总表", "usage": "3.4", "price": "0.65"},
                {"date": "2026-09-01", "meter": "总表", "usage": "2.1", "price": "0.65"},
            ],
            remaining=12.5,
        )
        items = items_for(
            cache,
            "D7-502",
            "used",
            DateRange(dt.date(2026, 9, 1), dt.date(2026, 9, 30)),
        )
        self.assertEqual([item["date"] for item in items], ["2026-09-01", "2026-09-02"])
        self.assertEqual(cache["rooms"]["D7-502"]["remaining"], 12.5)
        self.assertEqual(
            missing_ranges(
                cache["rooms"]["D7-502"],
                "used",
                DateRange(dt.date(2026, 9, 1), dt.date(2026, 9, 30)),
            ),
            [DateRange(dt.date(2026, 9, 3), dt.date(2026, 9, 30))],
        )

    def test_summary_and_dual_chart(self):
        used = [
            {"date": "2026-07-01", "usage": "3.0"},
            {"date": "2026-07-02", "usage": "2.0"},
        ]
        bought = [{"date": "2026-07-01", "quantity": "10", "amount": "6.5"}]
        summary = summarize_records(used, bought, dt.date(2026, 7, 1), dt.date(2026, 7, 2))
        self.assertEqual(summary["used"]["total_kwh"], 5.0)
        self.assertEqual(summary["used"]["average_kwh_per_calendar_day"], 2.5)
        self.assertEqual(summary["buy"]["total_amount"], 6.5)
        self.assertEqual(summary["seasonal_used"]["夏季"]["average_kwh_per_recorded_day"], 2.5)

        with tempfile.TemporaryDirectory() as directory:
            target = write_combined_svg(
                used,
                bought,
                Path(directory) / "chart.svg",
                "测试图表",
            )
            text = target.read_text(encoding="utf-8")
            self.assertIn("测试图表", text)
            self.assertIn('stroke="#2563eb"', text)
            self.assertIn('fill="#dc2626"', text)


if __name__ == "__main__":
    unittest.main()