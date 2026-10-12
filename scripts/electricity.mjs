#!/usr/bin/env node
/**
 * Campus electricity report — fetch, cache, and render one self-contained HTML.
 *
 *   node scripts/electricity.mjs --room D1-101              # incremental + report
 *   node scripts/electricity.mjs --room D13-1001 --full     # refetch everything
 *   node scripts/electricity.mjs --room D1-101 --report-only --open
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { DEFAULT_BASE, Client } from './lib/client.mjs';
import { resolveRoom, fetchRecords, CATALOG_MAX_AGE_MS } from './lib/site.mjs';
import { buildCatalog } from './lib/catalog.mjs';
import { loadCatalog, saveCatalog, catalogAgeMs, roomKey } from './lib/rooms.mjs';
import { loadCache, saveCache, emptyCache, planRefresh, mergeUsed, mergeBuy, cacheRange } from './lib/cache.mjs';
import { writeReport } from './lib/report.mjs';
import { today, isValidDate, addDays } from './lib/dates.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CONFIG_FILE = path.join(ROOT, 'config.json');

/* ------------------------------------------------------------------- config */
const DEFAULTS = {
  room: null,
  base: DEFAULT_BASE,
  concurrency: 6,
  policy: 'max',
  theme: 'light',
  historyStart: '2020-01-01',
  recheckDays: 7,
  browser: 'edge',
};

function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--room': case '-r': out.room = next(); break;
      case '--from': out.from = next(); break;
      case '--to': out.to = next(); break;
      case '--conc': case '--concurrency': out.concurrency = Number(next()); break;
      case '--policy': out.policy = next(); break;
      case '--theme': out.theme = next(); break;
      case '--base': out.base = next(); break;
      case '--out': out.out = next(); break;
      case '--refresh-catalog': out.refreshCatalog = true; break;
      case '--full': out.full = true; break;
      case '--no-report': out.noReport = true; break;
      case '--report-only': out.reportOnly = true; break;
      case '--open': out.open = true; break;
      case '--json': out.json = true; break;
      case '--quiet': case '-q': out.quiet = true; break;
      case '--help': case '-h': out.help = true; break;
      default: throw new Error(`unknown argument: ${a}`);
    }
  }
  return out;
}

const HELP = `usage: node scripts/electricity.mjs --room <D1-101> [options]

  --room, -r <name>   房间名或 6 位编码（D1-101 / D13-1001 / 国交-101 / 010101）
  --from <date>       起始日期，默认 ${DEFAULTS.historyStart}
  --to <date>         结束日期，默认今天
  --conc <n>          并发会话数，默认 ${DEFAULTS.concurrency}
  --policy <p>        同日多值取舍：max|sum|min|first|last，默认 ${DEFAULTS.policy}
  --theme <t>         报告主题 light|dark
  --full              忽略缓存，重新拉取整个区间
  --no-report         只抓数据不生成报告
  --report-only       只用缓存重新生成报告
  --refresh-catalog   强制重建房间目录
  --out <file>        报告输出路径
  --open              生成后用 Edge 打开
  --json              以 JSON 输出结果摘要
  --quiet, -q         安静模式
`;

/* --------------------------------------------------------------------- main */
const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
const config = { ...loadConfig(), ...Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined)) };
const log = (...m) => { if (!config.quiet) console.error(...m); };

const base = config.base;
const dataDir = path.join(ROOT, 'data');
const outDir = path.join(ROOT, 'out');
const catalogFile = path.join(dataDir, 'rooms.json');

const from = isValidDate(config.from) ? config.from : config.historyStart;
const to = isValidDate(config.to) ? config.to : today();
if (from > to) throw new Error(`--from (${from}) is after --to (${to})`);

/* 1. catalog ---------------------------------------------------------------- */
let catalog = loadCatalog(catalogFile);
if (!catalog || config.refreshCatalog || catalogAgeMs(catalog) > CATALOG_MAX_AGE_MS) {
  log('· 正在更新房间目录（约 2 秒）…');
  catalog = await buildCatalog({ base, concurrency: Math.min(config.concurrency, 6) });
  saveCatalog(catalogFile, catalog);
}

/* 2. room ------------------------------------------------------------------- */
const room = await resolveRoom(new Client({ base }), config.room, { catalog, catalogFile, base, refreshCatalog: false });
log(`· 房间 ${room.name}  (${room.building ?? ''}${room.floor ? ' ' + room.floor : ''} · 编码 ${room.fangjian})`);

/* 3. cache ------------------------------------------------------------------ */
const cacheFile = path.join(dataDir, `${roomKey(room.name).replace(/[^\w\u4e00-\u9fa5-]+/g, '_')}.json`);
let cache = loadCache(cacheFile) ?? emptyCache(room);
if (cache.fangjian !== room.fangjian) cache = emptyCache(room);

const reportFile = config.out
  ? path.resolve(config.out)
  : path.join(outDir, `${roomKey(room.name).replace(/[^\w\u4e00-\u9fa5-]+/g, '_')}-用电报告.html`);

const result = { room: room.name, code: room.fangjian, from, to, fetched: {}, cache: cacheFile, report: null };

/* 4. fetch ------------------------------------------------------------------ */
if (!config.reportOnly) {
  const jobs = [];
  for (const kind of ['used', 'buy']) {
    const ranges = planRefresh(cache, kind, { from, to, recheckDays: config.recheckDays, full: config.full });
    for (const range of ranges) jobs.push({ kind, range });
  }

  if (!jobs.length) {
    log('· 缓存已是最新，无需抓取');
  } else {
    // Kinds run sequentially at full concurrency: splitting the budget across
    // both kinds measurably slows the backfill down.
    const plan = { used: jobs.filter((j) => j.kind === 'used'), buy: jobs.filter((j) => j.kind === 'buy') };
    const totals = { used: plan.used.length, buy: plan.buy.length };
    log(`· 需要抓取 ${jobs.length} 个时间片（用电 ${totals.used} / 购电 ${totals.buy}），并发 ${config.concurrency}`);
    const t0 = Date.now();

    const progress = (kind) => (p) => {
      if (!process.stderr.isTTY || config.quiet) return;
      process.stderr.write(`\r  ${kind === 'used' ? '用电' : '购电'} ${p.done}/${totals[kind]} 片 · ${p.records} 条 · ${p.requests} 请求   `);
    };

    const runKind = async (kind, ranges) => {
      let records = [], requests = 0, failures = [], balance = null, acBalance = null;
      for (const range of ranges) {
        const res = await fetchRecords({
          room, kind, from: range[0], to: range[1], base,
          concurrency: config.concurrency,
          onProgress: progress(kind),
        });
        records = records.concat(res.records);
        requests += res.requests;
        failures = failures.concat(res.failures);
        if (res.balance != null) balance = res.balance;
        if (res.acBalance != null) acBalance = res.acBalance;
        if (kind === 'used') mergeUsed(cache, res.records, range);
        else mergeBuy(cache, res.records, range);
        // Persist after each range so an interrupted backfill is not wasted.
        saveCache(cacheFile, cache);
      }
      if (process.stderr.isTTY && !config.quiet) process.stderr.write('\r' + ' '.repeat(72) + '\r');
      return { kind, records, requests, failures, balance, acBalance };
    };

    const empty = { records: [], requests: 0, failures: [], balance: null, acBalance: null };
    const usedRes = plan.used.length ? await runKind('used', plan.used.map((j) => j.range)) : empty;
    const buyRes = plan.buy.length ? await runKind('buy', plan.buy.map((j) => j.range)) : empty;

    const elapsed = Date.now() - t0;
    const bal = usedRes.balance ?? buyRes.balance;
    const ac = usedRes.acBalance ?? buyRes.acBalance;
    if (bal != null) { cache.balance = bal; cache.balanceAt = new Date().toISOString(); }
    if (ac != null) cache.acBalance = ac;
    cache.updatedAt = new Date().toISOString();
    cache.room = room.name;
    cache.building = room.building ?? cache.building;
    cache.floor = room.floor ?? cache.floor;

    const failures = [...usedRes.failures, ...buyRes.failures];
    if (failures.length) {
      cache.notes = failures.slice(0, 20).map((f) => `${f.range ?? f.stage}: ${f.error}`);
      log(`! ${failures.length} 个时间片抓取失败（已跳过，可重跑补齐）`);
      for (const f of failures.slice(0, 5)) log(`    ${f.range ?? f.stage} → ${f.error}`);
    } else {
      cache.notes = [];
    }

    saveCache(cacheFile, cache);
    result.fetched = {
      used: usedRes.records.length, buy: buyRes.records.length,
      requests: usedRes.requests + buyRes.requests, elapsedMs: elapsed, failures: failures.length,
    };
    log(`· 抓取完成：用电 ${usedRes.records.length} 条 / 购电 ${buyRes.records.length} 条，` +
      `${usedRes.requests + buyRes.requests} 次请求，用时 ${(elapsed / 1000).toFixed(1)} 秒`);
  }
}

/* 5. report ----------------------------------------------------------------- */
if (!config.noReport) {
  const { bytes } = writeReport(reportFile, { cache, policy: config.policy, theme: config.theme, from, to });
  result.report = reportFile;
  result.reportBytes = bytes;
  const r = cacheRange(cache);
  log(`· 报告已生成：${reportFile}`);
  log(`  数据范围 ${r.used ? r.used.join(' ~ ') : '无'} · 用电 ${r.days} 天 · 购电 ${r.buyCount} 笔` +
    (cache.balance != null ? ` · 当前余额 ${cache.balance} 度` : ''));
  if (config.open) openInBrowser(reportFile, config.browser);
}

if (config.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');

/* ------------------------------------------------------------------ helpers */
function openInBrowser(file, which) {
  const candidates = which === 'chrome'
    ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe']
    : [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      ];
  const exe = candidates.find((p) => fs.existsSync(p));
  // Never use the shell's default handler: on this machine that resolves to Chrome.
  if (exe) spawn(exe, [file], { detached: true, stdio: 'ignore' }).unref();
  else spawn('cmd', ['/c', 'start', '', file], { detached: true, stdio: 'ignore' }).unref();
}
