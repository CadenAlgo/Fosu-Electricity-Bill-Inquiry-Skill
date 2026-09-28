# Browser fallback

This script is only the standalone fallback when Codex cannot operate the current in-app browser tab.

`electricity_flow.mjs` opens the public dormitory selector, validates building/floor/room options, reads usage or purchase records, follows pagination, normalizes record dates, and writes JSON. It does not require credentials.

Examples:

```text
node browser/electricity_flow.mjs --preset 30d --room D7502 --record-type both
node browser/electricity_flow.mjs --preset 1y --room D7502 --record-type used
```

The fallback tries installed Chrome first and Edge second. It uses a separate ignored persistent profile and never copies the user's daily browser profile or cookies.