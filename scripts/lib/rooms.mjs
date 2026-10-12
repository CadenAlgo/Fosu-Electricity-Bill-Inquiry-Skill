/**
 * Room-name resolution.
 *
 * The site's own room list is the only reliable source of truth: room numbers
 * cannot be computed from the label. Examples that break arithmetic:
 *   - D13 一层 starts at D13-104 (not D13-101)
 *   - D1 一层 ends with D1-值班室
 *   - D30 has rooms named D30-1单元公共
 *   - D20 一层 is listed twice
 * So we look labels up in a cached catalog, and only fall back to arithmetic
 * when the catalog is unavailable.
 */
import fs from 'node:fs';
import path from 'node:path';

const FULLWIDTH = /[\uFF01-\uFF5E]/g;
const toHalfWidth = (s) => s.replace(FULLWIDTH, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

/** Canonical comparison key: half-width, no spaces, no separator, upper-cased latin. */
export function roomKey(input) {
  return toHalfWidth(String(input ?? ''))
    .replace(/\s+/g, '')
    .replace(/[‐‑‒–—―－_]/g, '-')
    .toUpperCase();
}

/** Key used for catalog lookups: separators removed entirely, so D1-101 == D1101. */
export const looseKey = (input) => roomKey(input).replace(/-/g, '');

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Turn a room label or code into the three dropdown values.
 * `D13-1001` -> { louming: '13', ceng: '1310', fangjian: '131001' }
 * `D1-101`   -> { louming: '01', ceng: '0101', fangjian: '010101' }
 * Returns null when the label does not have a recognizable tail.
 */
export function deriveCodes(label, buildingValue) {
  const key = roomKey(label);
  const m = /^(.*?)-?(\d{3,4})$/.exec(key);
  if (!m) return null;
  const [, , digits] = m;
  // 3 digits -> single-digit floor (D1-101); 4 digits -> two-digit floor (D13-1001).
  const floor = digits.length === 4 ? Number(digits.slice(0, 2)) : Number(digits[0]);
  const index = Number(digits.slice(-2));
  if (!Number.isFinite(floor) || !Number.isFinite(index)) return null;
  const b = String(buildingValue ?? '').padStart(2, '0');
  return { louming: b, ceng: b + pad2(floor), fangjian: b + pad2(floor) + pad2(index) };
}

/** Every catalog label that could correspond to the user's input, best first. */
export function candidateLabels(catalog, input) {
  const raw = roomKey(input);
  const out = new Set();
  if (!raw) return [];
  out.add(raw);

  const buildings = (catalog?.buildings ?? []).map((b) => b.label);
  for (const b of buildings) {
    const bl = roomKey(b);
    if (raw.startsWith(bl) && raw.length > bl.length) {
      const rest = raw.slice(bl.length).replace(/^-/, '');
      if (rest) out.add(`${bl}-${rest}`);
    }
  }

  // `D131001` -> try every split of the trailing digits across building + room.
  const m = /^([A-Z\u4e00-\u9fa5]+)(\d{3,6})$/.exec(raw);
  if (m) {
    const [, letters, digits] = m;
    for (let k = 1; k <= 2 && k < digits.length; k++) {
      const candidate = `${letters}${digits.slice(0, k)}-${digits.slice(k)}`;
      out.add(candidate);
    }
  }
  return [...out];
}

/** Lazily built lookup maps, cached per catalog object. */
const indexCache = new WeakMap();
function indexes(catalog) {
  let cached = indexCache.get(catalog);
  if (!cached) {
    const loose = new Map();
    const byCode = new Map();
    for (const entry of Object.values(catalog?.index ?? {})) {
      loose.set(looseKey(entry.name), entry);
      byCode.set(String(entry.fangjian), entry);
    }
    cached = { loose, byCode };
    indexCache.set(catalog, cached);
  }
  return cached;
}

/**
 * Find a room in the catalog.
 * Prefers an exact label match, then any label that differs only by separator.
 */
export function resolveFromCatalog(catalog, input) {
  if (!catalog?.index) return null;
  const raw = roomKey(input);
  for (const cand of candidateLabels(catalog, input)) {
    if (catalog.index[cand]) return { ...catalog.index[cand], matchedBy: 'exact' };
  }
  const hit = indexes(catalog).loose.get(looseKey(raw));
  return hit ? { ...hit, matchedBy: 'loose' } : null;
}

/** Look a room up by its raw 6-digit dropdown code. */
export function roomByCode(catalog, code) {
  if (!catalog?.index) return null;
  const hit = indexes(catalog).byCode.get(String(code));
  return hit ? { ...hit, matchedBy: 'code' } : null;
}

/** Cheap similarity suggestions for a typo'd room name. */
export function suggestRooms(catalog, input, limit = 5) {
  const want = looseKey(input);
  if (!want || !catalog?.index) return [];
  const scored = [];
  for (const entry of Object.values(catalog.index)) {
    const key = looseKey(entry.name);
    if (Math.abs(key.length - want.length) > 3) continue;
    let same = 0;
    for (let i = 0; i < Math.min(key.length, want.length); i++) if (key[i] === want[i]) same++;
    const score = same / Math.max(key.length, want.length);
    if (score > 0.5) scored.push([score, entry.name]);
  }
  scored.sort((a, b) => b[0] - a[0] || (a[1] < b[1] ? -1 : 1));
  return scored.slice(0, limit).map(([, name]) => name);
}

export function loadCatalog(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function saveCatalog(file, catalog) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(catalog, null, 1));
  return file;
}

export const catalogAgeMs = (catalog) =>
  catalog?.fetchedAt ? Date.now() - new Date(catalog.fetchedAt).getTime() : Infinity;
