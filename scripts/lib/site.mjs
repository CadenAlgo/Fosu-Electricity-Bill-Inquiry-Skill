/**
 * Site-specific flow for the campus electricity query system.
 *
 * Flow (all POSTs hit the application root, i.e. Default.aspx):
 *   1. GET  /                      -> building list + __VIEWSTATE
 *   2. POST __EVENTTARGET=drlouming -> floor list for the building
 *   3. POST __EVENTTARGET=drceng    -> room list for the floor
 *   4. POST drfangjian + radio + ImageButton1.x/y
 *          -> 302 to /usedRecord.aspx or /buyRecord.aspx (session carries the choice)
 *   5. GET  that path  -> result page with a date filter and 10 rows/page
 *   6. POST txtstart/txtend/btnser -> filtered page 1
 *   7. GET  <page>?p=N             -> filtered page N   (columns are 1-based; p=0 is empty)
 */

import { Client, hiddenFields, selectOptions, pageInfo, tableRows, balanceFromBanner, withRetry, DEFAULT_BASE } from './client.mjs';
import { shardRange, addDays, stampDate, today } from './dates.mjs';
import { resolveFromCatalog, roomByCode, suggestRooms, loadCatalog, saveCatalog, catalogAgeMs, candidateLabels, roomKey, deriveCodes } from './rooms.mjs';
import { buildCatalog } from './catalog.mjs';

export { DEFAULT_BASE };

export const RECORD_KINDS = {
  used: { radio: 'usedR', path: 'usedRecord.aspx', label: '用电记录' },
  buy: { radio: 'buyR', path: 'buyRecord.aspx', label: '购电记录' },
};

/**
 * Shard width per record kind.
 *
 * Measured on a cold server-side cache (2 years / 731 records each, same room
 * class): 6-day shards at concurrency 12 finish in 12.8s (17ms/record), while
 * 12-day shards take 23s, 20-day 34s and 90-day 156s. The site's OFFSET
 * pagination makes each page more expensive as the result set grows, so small
 * shards win even though they mean more queries.
 */
export const DEFAULT_SHARD_DAYS = { used: 6, buy: 30 };

/* -------------------------------------------------------------- room catalog */

/** Building list straight off the login form. */
export async function listBuildings(client) {
  const { text } = await withRetry(() => client.get(''), { label: 'GET /' });
  return {
    viewState: hiddenFields(text),
    buildings: selectOptions(text, 'drlouming').filter((o) => o.value),
  };
}

export async function listFloors(client, building) {
  const { viewState, buildings } = await listBuildings(client);
  const res = await withRetry(
    () =>
      client.post('', {
        __EVENTTARGET: 'drlouming',
        __EVENTARGUMENT: '',
        __VIEWSTATE: viewState.__VIEWSTATE,
        __VIEWSTATEGENERATOR: viewState.__VIEWSTATEGENERATOR,
        drlouming: building,
        drceng: '',
        drfangjian: '',
      }),
    { label: 'POST drlouming' }
  );
  return {
    viewState: hiddenFields(res.text),
    floors: selectOptions(res.text, 'drceng').filter((o) => o.value),
    buildings,
  };
}

export async function listRooms(client, building, floor) {
  const { viewState } = await listFloors(client, building);
  const res = await withRetry(
    () =>
      client.post('', {
        __EVENTTARGET: 'drceng',
        __EVENTARGUMENT: '',
        __VIEWSTATE: viewState.__VIEWSTATE,
        __VIEWSTATEGENERATOR: viewState.__VIEWSTATEGENERATOR,
        drlouming: building,
        drceng: floor,
        drfangjian: '',
      }),
    { label: 'POST drceng' }
  );
  return { viewState: hiddenFields(res.text), rooms: selectOptions(res.text, 'drfangjian').filter((o) => o.value) };
}

/** Catalog freshness window; rebuilding costs ~2s so this only avoids pointless work. */
export const CATALOG_MAX_AGE_MS = 14 * 24 * 3600 * 1000;

/**
 * Resolve a user-supplied room into the three dropdown values the site expects.
 *
 * Accepts `D1-101`, `D1101`, `d1 101`, `D13-1001`, `D131001`, `国交-101`,
 * `河滨101`, `D1-值班室`, or a raw 6-digit code such as `010101`.
 *
 * The cached catalog is authoritative because room numbers cannot be computed:
 * D13 一层 starts at D13-104, D1 一层 ends with D1-值班室, and D20 一层 is
 * listed twice. Arithmetic derivation is only a fallback for a stale catalog.
 */
export async function resolveRoom(client, input, { catalog, catalogFile, base = DEFAULT_BASE, refreshCatalog = false } = {}) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('room is required, e.g. --room D1-101');

  let cat = catalog ?? (catalogFile ? loadCatalog(catalogFile) : null);
  if (!cat || refreshCatalog || catalogAgeMs(cat) > CATALOG_MAX_AGE_MS) {
    cat = await buildCatalog({ base });
    if (catalogFile) saveCatalog(catalogFile, cat);
  }

  const hit = resolveFromCatalog(cat, raw);
  if (hit) return { ...hit, source: 'catalog', catalog };

  // A bare 6-digit dropdown code: building(2) + floor(2) + index(2) = 010101.
  if (/^\d{6}$/.test(raw)) {
    const known = roomByCode(cat, raw);
    if (known) return { ...known, source: 'catalog', catalog };
    throw new Error(
      `room code "${raw}" is not in the catalog (building ${raw.slice(0, 2)}, floor ${raw.slice(2, 4)}); ` +
        'pass a room name such as D1-101, or rerun `node scripts/catalog.mjs` to refresh the list.'
    );
  }

  // Fallback: derive codes from the label, then confirm against the live form.
  // Needs a live client; without one we can only report the failure.
  const buildings = cat.buildings ?? [];
  for (const label of client ? candidateLabels(cat, raw) : []) {
    const match = /^([^-]+)-(\d{3,4})$/.exec(label);
    if (!match) continue;
    const building = buildings.find((b) => roomKey(b.label) === roomKey(match[1]));
    if (!building) continue;
    const { louming, ceng, fangjian } = deriveCodes(label, building.value) ?? {};
    if (!fangjian) continue;
    const { rooms } = await listRooms(client, louming, ceng);
    const found = rooms.find((r) => r.value === fangjian);
    if (found) {
      const floorLabel = buildings.find((b) => b.value === louming)?.floors?.find((f) => f.value === ceng)?.label ?? ceng;
      return { louming, ceng, fangjian, name: found.label, building: building.label, floor: floorLabel, source: 'derived', catalog: cat };
    }
  }

  const hints = suggestRooms(cat, raw);
  throw new Error(
    `room "${raw}" not found in the catalog` +
      (hints.length ? `. Did you mean: ${hints.join(', ')}?` : '. Run `node scripts/catalog.mjs` to refresh the room list.')
  );
}

/* ------------------------------------------------------------------- workers */

/**
 * One worker = one independent HTTP session that has already navigated to a
 * record page. Separate sessions matter: ASP.NET serialises concurrent
 * requests that share a session id, which is what makes naive parallel
 * scraping slower than sequential.
 */
export class RecordSession {
  constructor({ room, kind, base = DEFAULT_BASE }) {
    this.room = room;
    this.kind = RECORD_KINDS[kind];
    if (!this.kind) throw new Error(`unknown kind ${kind}`);
    this.client = new Client({ base });
    this.pagePath = this.kind.path;
    this.viewState = null;
    this.balance = null;
    this.acBalance = null;
    this.banner = null;
  }

  async open() {
    const { viewState, buildings } = await listBuildings(this.client);
    const floorRes = await withRetry(
      () =>
        this.client.post('', {
          __EVENTTARGET: 'drlouming',
          __EVENTARGUMENT: '',
          __VIEWSTATE: viewState.__VIEWSTATE,
          __VIEWSTATEGENERATOR: viewState.__VIEWSTATEGENERATOR,
          drlouming: this.room.louming,
          drceng: '',
          drfangjian: '',
        }),
      { label: 'open drlouming' }
    );
    const floorVs = hiddenFields(floorRes.text);
    const roomRes = await withRetry(
      () =>
        this.client.post('', {
          __EVENTTARGET: 'drceng',
          __EVENTARGUMENT: '',
          __VIEWSTATE: floorVs.__VIEWSTATE,
          __VIEWSTATEGENERATOR: floorVs.__VIEWSTATEGENERATOR,
          drlouming: this.room.louming,
          drceng: this.room.ceng,
          drfangjian: '',
        }),
      { label: 'open drceng' }
    );
    const roomVs = hiddenFields(roomRes.text);
    const submit = await withRetry(
      () =>
        this.client.post('', {
          __EVENTTARGET: '',
          __EVENTARGUMENT: '',
          __VIEWSTATE: roomVs.__VIEWSTATE,
          __VIEWSTATEGENERATOR: roomVs.__VIEWSTATEGENERATOR,
          drlouming: this.room.louming,
          drceng: this.room.ceng,
          drfangjian: this.room.fangjian,
          radio: this.kind.radio,
          'ImageButton1.x': '10',
          'ImageButton1.y': '10',
        }),
      { label: 'open submit' }
    );
    if (submit.status !== 302 || !submit.location) {
      void buildings;
      throw new Error(`room selection was rejected (HTTP ${submit.status}); check the room code`);
    }
    this.pagePath = submit.location;
    const page = await withRetry(
      () => this.client.get(this.pagePath, { headers: { Referer: this.client.base } }),
      { label: 'open record page' }
    );
    if (!/dataTable/.test(page.text)) throw new Error('record page did not render (unexpected markup)');
    this.viewState = hiddenFields(page.text);
    const { balance, acBalance } = balanceFromBanner(page.text);
    this.balance = balance;
    this.acBalance = acBalance;
    return page.text;
  }

  /** Apply a date filter; returns the page-1 rows and the total page count. */
  async setRange(start, end) {
    const res = await withRetry(
      () =>
        this.client.post(this.pagePath, {
          __VIEWSTATE: this.viewState.__VIEWSTATE,
          __VIEWSTATEGENERATOR: this.viewState.__VIEWSTATEGENERATOR,
          __EVENTVALIDATION: this.viewState.__EVENTVALIDATION,
          txtstart: start,
          txtend: end,
          btnser: '查询',
        }),
      { label: `filter ${start}..${end}` }
    );
    this.viewState = hiddenFields(res.text);
    const info = pageInfo(res.text);
    return { totalPages: info?.totalPages ?? 0, rows: tableRows(res.text) };
  }

  /** Fetch page N (1-based) of the filtering currently held by the session. */
  async page(n) {
    const res = await withRetry(
      () => this.client.get(`${this.pagePath}?p=${n}`),
      { label: `page ${n}` }
    );
    const info = pageInfo(res.text);
    if (info && info.totalPages === 0) return [];
    return tableRows(res.text);
  }
}

/* ---------------------------------------------------------------- fetch plan */

export function toUsedRecord(cells) {
  const [date, meter, kwh, price] = cells;
  return {
    date,
    meter: meter || '',
    kwh: Number(kwh),
    price: price === '' || price == null ? null : Number(price),
  };
}

export function toBuyRecord(cells) {
  const [stamp, meter, kwh, amount, operator] = cells;
  return {
    ts: stamp,
    date: stampDate(stamp),
    meter: meter || '',
    kwh: Number(kwh),
    amount: amount === '' || amount == null ? null : Number(amount),
    operator: operator || '',
  };
}

/**
 * Fetch every record of one kind for one room in [from, to].
 *
 * Concurrency is bounded by the number of independent sessions; each session
 * walks its own share of the date shards sequentially. Failures are isolated
 * per shard so one bad window cannot lose the whole backfill.
 */
export async function fetchRecords({
  room,
  kind,
  from,
  to,
  concurrency = 6,
  shardDays,
  base = DEFAULT_BASE,
  onProgress = () => {},
  onFirstSession = () => {},
}) {
  const days = shardDays ?? DEFAULT_SHARD_DAYS[kind];
  const shards = shardRange(from, to, days);
  const queue = shards.map(([s, e], index) => ({ s, e, index }));
  const total = queue.length;

  const toRecord = kind === 'used' ? toUsedRecord : toBuyRecord;
  const records = [];
  const failures = [];
  const seenPages = new Set();
  let requests = 0;
  let done = 0;
  let banner = null;
  let firstSessionDone = false;

  const workerCount = Math.max(1, Math.min(concurrency, total));

  const workers = Array.from({ length: workerCount }, async (_, workerId) => {
    const session = new RecordSession({ room, kind, base });
    try {
      const html = await session.open();
      requests += 6;
      if (!firstSessionDone) {
        firstSessionDone = true;
        onFirstSession({ balance: session.balance, acBalance: session.acBalance, html });
      }
      if (banner === null) banner = { balance: session.balance, acBalance: session.acBalance };
    } catch (err) {
      failures.push({ worker: workerId, stage: 'open', error: String(err?.message ?? err) });
      return;
    }

    for (;;) {
      const job = queue.shift();
      if (!job) break;
      try {
        const first = await session.setRange(job.s, job.e);
        requests += 1;
        for (const cells of first.rows) records.push({ ...toRecord(cells), _shard: job.index });
        for (let p = 2; p <= first.totalPages; p++) {
          const rows = await session.page(p);
          requests += 1;
          for (const cells of rows) records.push({ ...toRecord(cells), _shard: job.index });
          if (!rows.length) break;
        }
        seenPages.add(job.index);
      } catch (err) {
        failures.push({ worker: workerId, range: `${job.s}..${job.e}`, error: String(err?.message ?? err) });
      }
      done += 1;
      onProgress({ done, total, requests, records: records.length, failures: failures.length });
    }
  });

  await Promise.all(workers);

  return {
    kind,
    room: room.name ?? room.fangjian,
    from,
    to,
    shards: total,
    requests,
    records,
    failures,
    balance: banner?.balance ?? null,
    acBalance: banner?.acBalance ?? null,
    fetchedAt: new Date().toISOString(),
  };
}

/** Quick probe: current balance + latest record date, using a single session. */
export async function probe({ room, kind = 'used', base = DEFAULT_BASE }) {
  const session = new RecordSession({ room, kind, base });
  await session.open();
  const end = today();
  const start = addDays(end, -30);
  const { totalPages, rows } = await session.setRange(start, end);
  return {
    balance: session.balance,
    acBalance: session.acBalance,
    totalPages,
    rows: rows.map(kind === 'used' ? toUsedRecord : toBuyRecord),
  };
}
