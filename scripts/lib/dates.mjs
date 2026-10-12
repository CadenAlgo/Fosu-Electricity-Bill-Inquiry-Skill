/** Date helpers working on local-time `YYYY-MM-DD` strings (no timezone surprises). */

export const pad2 = (n) => String(n).padStart(2, '0');

/** Date -> `YYYY-MM-DD` in local time. */
export function fmtDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** `YYYY-MM-DD` -> local-midnight Date. */
export function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim());
  if (!m) throw new Error(`invalid date: ${s} (expected YYYY-MM-DD)`);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export const isValidDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s ?? '').trim());

export function addDays(dateStr, days) {
  const d = parseDate(dateStr);
  d.setDate(d.getDate() + days);
  return fmtDate(d);
}

export function today(now = new Date()) {
  return fmtDate(now);
}

/** Inclusive day count between two `YYYY-MM-DD` strings. */
export function daysBetween(from, to) {
  return Math.round((parseDate(to) - parseDate(from)) / 86400000) + 1;
}

/** Inclusive list of dates between two `YYYY-MM-DD` strings. */
export function eachDay(from, to) {
  const out = [];
  for (let s = from; s <= to; s = addDays(s, 1)) out.push(s);
  return out;
}

/**
 * Split an inclusive date range into consecutive shards of at most `days` days.
 * Sharding keeps each server-side query small, which matters a lot: the site's
 * OFFSET pagination gets dramatically slower as the result set grows.
 */
export function shardRange(from, to, days) {
  const out = [];
  if (from > to) return out;
  let cur = from;
  while (cur <= to) {
    const end = addDays(cur, days - 1);
    const stop = end > to ? to : end;
    out.push([cur, stop]);
    cur = addDays(stop, 1);
  }
  return out;
}

/** `2026/9/25 9:04:41` -> `2026-09-25T09:04:41`; returns null when unparseable. */
export function normalizeStamp(s) {
  const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(String(s).trim());
  if (!m) return null;
  const [, y, mo, d, h = '0', mi = '0', sec = '0'] = m;
  return `${y}-${pad2(+mo)}-${pad2(+d)}T${pad2(+h)}:${mi}:${sec}`;
}

/** `2026/9/25 9:04:41` -> `2026-09-25`; returns null when unparseable. */
export function stampDate(s) {
  const iso = normalizeStamp(s);
  return iso ? iso.slice(0, 10) : null;
}

/** Monday-based ISO week key, e.g. `2026-W41`. */
export function weekKey(dateStr) {
  const d = parseDate(dateStr);
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day + 3);
  const firstThursday = new Date(d.getFullYear(), 0, 4);
  const fday = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() - fday + 3);
  const week = 1 + Math.round((d - firstThursday) / (7 * 86400000));
  return `${d.getFullYear()}-W${pad2(week)}`;
}

export const monthKey = (dateStr) => dateStr.slice(0, 7);
