/**
 * Local JSON cache.
 *
 * Two design choices worth keeping:
 *
 *  - Used records are stored as *all* entries seen for a date, not a single
 *    number. Roughly 70 days on campus return two rows with different kWh for
 *    the same day; keeping both means the resolution policy (max/sum/first)
 *    stays a report-time choice instead of forcing a refetch.
 *  - Buy records are replaced per date range, so the trailing re-check window
 *    refreshes corrections without accumulating duplicate rows across runs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { addDays, eachDay, today } from './dates.mjs';

export const CACHE_VERSION = 2;

export function emptyCache(room) {
  return {
    version: CACHE_VERSION,
    room: room.name,
    code: room.fangjian,
    building: room.building ?? null,
    floor: room.floor ?? null,
    louming: room.louming,
    ceng: room.ceng,
    fangjian: room.fangjian,
    updatedAt: null,
    balance: null,
    acBalance: null,
    balanceAt: null,
    used: {},
    buy: [],
    covered: { used: null, buy: null },
    notes: [],
  };
}

export function loadCache(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed?.version !== CACHE_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveCache(file, cache) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache));
  fs.renameSync(tmp, file);
  return file;
}

/**
 * Work out which date ranges must be fetched to satisfy [from, to].
 * Returns [] when the cache already covers everything (after the re-check
 * window, which re-reads recent days in case the meter data was revised).
 *
 * Note: `cache.covered[kind]` is a `[from, to]` tuple, not an object.
 */
export function planRefresh(cache, kind, { from, to, recheckDays = 7, full = false }) {
  if (full) return [[from, to]];
  const covered = coverageTuple(cache.covered?.[kind]);
  if (!covered) return [[from, to]];
  const [coveredFrom, coveredTo] = covered;

  const ranges = [];
  // Anything before what we already have.
  if (from < coveredFrom) ranges.push([from, addDays(coveredFrom, -1)]);
  // New days plus the overlap window (records are sometimes revised/backfilled).
  const resumeFrom = addDays(coveredTo, 1 - recheckDays);
  const start = resumeFrom < from ? from : resumeFrom;
  if (start <= to) ranges.push([start, to]);
  return mergeRanges(ranges);
}

export function mergeRanges(ranges) {
  const sorted = ranges.filter(([a, b]) => a <= b).sort((x, y) => (x[0] < y[0] ? -1 : 1));
  const out = [];
  for (const [a, b] of sorted) {
    const last = out.at(-1);
    if (last && a <= addDays(last[1], 1)) last[1] = b > last[1] ? b : last[1];
    else out.push([a, b]);
  }
  return out;
}

/** Merge fetched used records into the cache (entries are replaced per date). */
export function mergeUsed(cache, records, range) {
  const touched = new Set(eachDay(range[0], range[1]));
  for (const date of touched) delete cache.used[date];
  for (const r of records) {
    if (!r.date || !Number.isFinite(r.kwh)) continue;
    const bucket = (cache.used[r.date] ??= { entries: [] });
    if (!bucket.entries.some((e) => e.kwh === r.kwh && e.meter === r.meter && e.price === r.price)) {
      bucket.entries.push({ kwh: r.kwh, price: r.price ?? null, meter: r.meter ?? '' });
    }
  }
  extendCoverage(cache, 'used', range);
  return cache;
}

/** Merge fetched buy records into the cache (rows are replaced per date). */
export function mergeBuy(cache, records, range) {
  const touched = new Set(eachDay(range[0], range[1]));
  cache.buy = cache.buy.filter((r) => !touched.has(r.date));
  for (const r of records) {
    if (!r.date || !touched.has(r.date)) continue;
    if (!Number.isFinite(r.kwh) && !Number.isFinite(r.amount)) continue;
    cache.buy.push({
      ts: r.ts ?? null,
      date: r.date,
      meter: r.meter ?? '',
      kwh: Number.isFinite(r.kwh) ? r.kwh : null,
      amount: Number.isFinite(r.amount) ? r.amount : null,
      operator: r.operator ?? '',
    });
  }
  cache.buy.sort((a, b) => (String(a.ts) < String(b.ts) ? -1 : 1));
  extendCoverage(cache, 'buy', range);
  return cache;
}

/** Read a `[from, to]` coverage tuple, tolerating a legacy `{from,to}` shape. */
export function coverageTuple(covered) {
  if (Array.isArray(covered)) return [covered[0], covered[1]];
  if (covered && typeof covered === 'object' && covered.from && covered.to) return [covered.from, covered.to];
  return null;
}

function extendCoverage(cache, kind, range) {
  cache.covered ??= { used: null, buy: null };
  const cur = coverageTuple(cache.covered[kind]);
  cache.covered[kind] = cur
    ? [range[0] < cur[0] ? range[0] : cur[0], range[1] > cur[1] ? range[1] : cur[1]]
    : [range[0], range[1]];
}

/* -------------------------------------------------------------- derivations */

/** Collapse a used-date bucket into a single kWh number using `policy`. */
export function applyPolicy(entries, policy = 'max') {
  const values = entries.map((e) => e.kwh).filter(Number.isFinite);
  if (!values.length) return 0;
  switch (policy) {
    case 'sum':
      return values.reduce((a, b) => a + b, 0);
    case 'min':
      return Math.min(...values);
    case 'first':
      return values[0];
    case 'last':
      return values.at(-1);
    case 'max':
    default:
      return Math.max(...values);
  }
}

/** Flatten the cache into per-day points for charting. */
export function usedSeries(cache, { policy = 'max', from, to } = {}) {
  const out = [];
  for (const [date, bucket] of Object.entries(cache.used ?? {})) {
    if (from && date < from) continue;
    if (to && date > to) continue;
    const entries = bucket.entries ?? [];
    out.push({
      date,
      kwh: applyPolicy(entries, policy),
      price: entries.find((e) => Number.isFinite(e.price))?.price ?? null,
      entries: entries.length,
      ambiguous: entries.length > 1,
    });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : 1));
  return out;
}

export function buySeries(cache, { from, to } = {}) {
  return (cache.buy ?? [])
    .filter((r) => (!from || r.date >= from) && (!to || r.date <= to))
    .slice()
    .sort((a, b) => (String(a.ts) < String(b.ts) ? -1 : 1));
}

export const cacheRange = (cache) => {
  const used = Object.keys(cache.used ?? {}).sort();
  const buy = (cache.buy ?? []).map((r) => r.date).filter(Boolean).sort();
  return {
    used: used.length ? [used[0], used.at(-1)] : null,
    buy: buy.length ? [buy[0], buy.at(-1)] : null,
    coverage: cache.covered,
    updatedAt: cache.updatedAt,
    balance: cache.balance,
    acBalance: cache.acBalance,
    days: used.length,
    buyCount: buy.length,
  };
};

export const defaultCacheFile = (dir, roomName) =>
  path.join(dir, `${String(roomName).replace(/[^\w\u4e00-\u9fa5-]+/g, '_')}.json`);

export { today };
