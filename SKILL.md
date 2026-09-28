---
name: fosu-campus-agent
description: Use this skill for Foshan University public dormitory electricity queries, including usage, purchase records, validation, caching, summaries, and zero-dependency charts.
---

# Foshan University Electricity Agent

This skill supports the public Foshan University dormitory electricity selector only. It does not support leave applications or any other campus workflow.

## Operating rules

1. Electricity is read-only. Never purchase electricity, pay, change account data, or request credentials for the public selector.
2. Do not store or print passwords, cookies, tokens, ViewState, or browser profiles.
3. Parse a room code such as `D7502`, `D131402`, `国交502`, or `河滨502` before opening the page. Validate the known building range and special floor limits locally.
4. Read the actual page options at every level. If the building, floor, or room does not exist, stop before clicking the query button and report the concrete value.
5. Query `used`, `buy`, or `both` separately. Preserve usage, purchase quantity, amount, purchaser, and unit price as different fields.
6. Normalize result dates from both `YYYY-MM-DD` and `M/D/YYYY h:mm:ss` formats. Keep zero-usage rows and multiple purchases on the same date.
7. Preserve missing dates as missing records; never invent zeroes.
8. Prefer the existing Codex in-app browser tab when it is already on the electricity site. Use the visible browser for the normal interaction. The standalone Chrome/Edge flow is only a fallback when in-app browser control is unavailable.
9. Use zero-dependency SVG for charts. Do not depend on CDN libraries. Report chart success only when the SVG contains actual drawing elements and data points.

## Public query path

Target: `http://10.10.60.223:8010/`

Use these controls:

- `#drlouming`: building
- `#drceng`: floor
- `#drfangjian`: room
- `#usedR` / `#buyR`: record type
- `#ImageButton1`: query
- `#txtstart` / `#txtend` / `#btnser`: result date filter

Supported room conventions:

- D1-D41 with three-digit room codes, for example `D7502` or `D20502`.
- D13 with a four-digit room code, for example `D131402` for floor 14 room 02.
- 国交 uses three-digit rooms and has up to 8 floors.
- 河滨 uses three-digit rooms and has up to 6 floors.

Supported ranges include today, yesterday, 7 days, 30 days, 3 months, 6 months, 1-4 years, and explicit start/end dates.

## Cache and presentation

For room-specific queries, use `.local/electricity-cache.json` as an ignored local cache. Record covered date intervals separately from returned items. Query only missing intervals and merge records by stable fields; purchase records must include their original time in the deduplication key.

Return remaining electricity when visible, the requested record groups, actual returned date range, counts, and summary statistics. If requested, write CSV and a zero-dependency SVG with a blue usage line on the left axis and red purchase points on the right axis.

## Natural interaction

Examples:

- “帮我查 D7502 最近 30 天的用电记录。”
- “帮我查 D7502 最近一年用电和购电，并生成图表。”
- “查 D131402 从 2026-08-01 到 2026-08-31 的购电记录。”

Do not ask for an account or password for a room-specific public query. If no room is provided, the older logged-in result-page fallback may be used only when the user clearly requests it.

## Standalone fallback

From the repository root:

```text
python -m fosu_campus_agent electricity --preset 30d --browser --room D7502 --record-type both
python -m fosu_campus_agent electricity --preset 1y --browser --room D7502 --record-type both --chart reports/generated/d7502-1y.svg
```

The fallback tries installed Chrome and then Edge. It does not require Playwright's bundled Chromium. It uses an ignored dedicated browser profile and never copies the user's daily profile.

## Local state

- `.local/`: temporary result and query-plan files, ignored by Git.
- `browser/profiles/electricity/`: dedicated ignored browser state.
- `reports/generated/`: optional ignored CSV/SVG output.

See `skills/electricity/SKILL.md` and `browser/README.md` for the detailed selector and fallback notes.