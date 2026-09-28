import datetime as dt
import unittest
from decimal import Decimal

from clients.electricity_client import ResponseFormatError, build_range, parse_readings


class ElectricityTests(unittest.TestCase):
    def test_presets_are_inclusive(self):
        today = dt.date(2026, 9, 24)
        self.assertEqual(build_range("today", today).start, today)
        self.assertEqual(build_range("7d", today).start, dt.date(2026, 9, 18))
        self.assertEqual(build_range("30d", today).start, dt.date(2026, 8, 26))


    def test_parse_common_payload(self):
        readings = parse_readings({"data": [{"date": "2026-09-24", "usage": "3.5 kWh"}]})
        self.assertEqual(readings[0].date, dt.date(2026, 9, 24))
        self.assertEqual(readings[0].value, Decimal("3.5"))


    def test_rejects_non_reading_payload(self):
        with self.assertRaises(ResponseFormatError):
            parse_readings({"message": "ok"})


if __name__ == "__main__":
    unittest.main()
