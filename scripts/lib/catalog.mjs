/**
 * Build a full catalog of buildings -> floors -> rooms by walking the site's
 * cascading dropdowns. The site has no bulk API for this, so it costs roughly
 * one request per floor (plus two per building); the result is cached in
 * data/rooms.json and reused by every later run.
 */
import { Client, selectOptions, hiddenFields, withRetry, DEFAULT_BASE } from './client.mjs';

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

export async function buildCatalog({ base = DEFAULT_BASE, concurrency = 6, onProgress = () => {} } = {}) {
  const probe = new Client({ base });
  const home = await withRetry(() => probe.get(''), { label: 'GET /' });
  const buildings = selectOptions(home.text, 'drlouming').filter((o) => o.value);

  let done = 0;
  const results = await mapLimit(buildings, concurrency, async (building) => {
    const client = new Client({ base });
    try {
      const first = await withRetry(() => client.get(''), { label: 'GET /' });
      let vs = hiddenFields(first.text);
      const floorRes = await withRetry(
        () =>
          client.post('', {
            __EVENTTARGET: 'drlouming',
            __EVENTARGUMENT: '',
            __VIEWSTATE: vs.__VIEWSTATE,
            __VIEWSTATEGENERATOR: vs.__VIEWSTATEGENERATOR,
            drlouming: building.value,
            drceng: '',
            drfangjian: '',
          }),
        { label: `POST drlouming ${building.label}` }
      );
      vs = hiddenFields(floorRes.text);
      const floors = selectOptions(floorRes.text, 'drceng').filter((o) => o.value);

      const floorData = [];
      for (const floor of floors) {
        const res = await withRetry(
          () =>
            client.post('', {
              __EVENTTARGET: 'drceng',
              __EVENTARGUMENT: '',
              __VIEWSTATE: vs.__VIEWSTATE,
              __VIEWSTATEGENERATOR: vs.__VIEWSTATEGENERATOR,
              drlouming: building.value,
              drceng: floor.value,
              drfangjian: '',
            }),
          { label: `POST drceng ${floor.label}` }
        );
        vs = hiddenFields(res.text);
        floorData.push({
          value: floor.value,
          label: floor.label,
          rooms: selectOptions(res.text, 'drfangjian').filter((o) => o.value).map((r) => ({ value: r.value, label: r.label })),
        });
      }
      done += 1;
      onProgress({ done, total: buildings.length, building: building.label });
      return { value: building.value, label: building.label, floors: floorData };
    } catch (err) {
      done += 1;
      onProgress({ done, total: buildings.length, building: building.label, error: String(err?.message ?? err) });
      return { value: building.value, label: building.label, error: String(err?.message ?? err), floors: [] };
    }
  });

  const index = {};
  for (const b of results) {
    for (const f of b.floors ?? []) {
      for (const r of f.rooms ?? []) {
        index[r.label] = { louming: b.value, ceng: f.value, fangjian: r.value, name: r.label, building: b.label, floor: f.label };
      }
    }
  }

  return {
    fetchedAt: new Date().toISOString(),
    base,
    buildings: results,
    index,
    counts: {
      buildings: results.length,
      floors: results.reduce((n, b) => n + (b.floors?.length ?? 0), 0),
      rooms: Object.keys(index).length,
    },
  };
}
