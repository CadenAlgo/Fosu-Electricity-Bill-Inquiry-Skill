import datetime as dt
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path

from clients.electricity_client import Reading
from reports.chart import write_csv, write_svg


class ReportTests(unittest.TestCase):
    def test_csv_and_svg_outputs(self):
        readings = [
            Reading(dt.date(2026, 9, 23), Decimal("22.16")),
            Reading(dt.date(2026, 9, 24), Decimal("19.31")),
        ]
        with tempfile.TemporaryDirectory() as directory:
            csv_path = write_csv(readings, Path(directory) / "usage.csv")
            svg_path = write_svg(readings, Path(directory) / "usage.svg")
            self.assertIn("2026-09-23,22.16,kWh", csv_path.read_text(encoding="utf-8"))
            self.assertIn("<polyline", svg_path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()

