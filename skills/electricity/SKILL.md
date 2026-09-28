# Electricity Skill

## Target

`http://10.10.60.223:8010/`

The public page exposes cascading selectors for building, floor, and room. The observed route does not require an account or password:

1. Select `#drlouming` (building).
2. Select `#drceng` (floor).
3. Select `#drfangjian` (room).
4. Select `#usedR` for usage or `#buyR` for purchase records.
5. Click `#ImageButton1`, then use `#txtstart`, `#txtend`, and `#btnser` on the result page.

The selector is read-only. Validate each actual option before the query. Missing buildings, floors, and rooms are errors, not empty results.

## Data rules

- `used`: date, meter, usage, unit price.
- `buy`: original purchase time, normalized date, meter, quantity, amount, purchaser when shown.
- `both`: keep the two groups separate.
- Preserve zero-usage rows.
- Do not deduplicate purchases by date alone; same-day purchases can be separate rows.
- Do not turn missing dates into zero.
- Normalize both `YYYY-MM-DD` and `M/D/YYYY h:mm:ss` dates.

Supported ranges include today, yesterday, 7d, 30d, 3m, 6m, 1y-4y, and explicit start/end dates. Room-specific queries use the local incremental JSON cache and only query missing intervals.