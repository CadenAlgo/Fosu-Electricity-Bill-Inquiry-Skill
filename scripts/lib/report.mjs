/**
 * Build a single self-contained HTML report.
 *
 * Everything (ECharts, CSS, the chart runtime, the full record cache) is
 * inlined, so the file works offline from `file://`, from a phone, or as an
 * e-mail attachment, with no CDN dependency.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ASSETS_DIR = path.resolve(HERE, '..', '..', 'assets');

const read = (p) => fs.readFileSync(p, 'utf8');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
/** Safe to embed inside a <script> tag. */
const jsonForScript = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028|\u2029/g, '');

export function buildReportHtml({ cache, policy = 'max', theme = 'light', from, to, generatedAt = new Date(), assetsDir = ASSETS_DIR }) {
  const dates = Object.keys(cache.used ?? {}).sort();
  const first = dates[0] ?? cache.covered?.used?.[0] ?? '2020-01-01';
  const last = dates[dates.length - 1] ?? first;

  const initialFrom = from && from >= first ? from : first;
  const initialTo = to && to <= last ? to : last;

  const payload = {
    room: { name: cache.room, code: cache.code, building: cache.building, floor: cache.floor },
    balance: cache.balance,
    acBalance: cache.acBalance,
    balanceAt: cache.balanceAt ?? cache.updatedAt,
    updatedAt: cache.updatedAt,
    coverage: cache.covered,
    used: cache.used ?? {},
    buy: cache.buy ?? [],
    options: { defaultPolicy: policy, theme, initialFrom, initialTo, requestedFrom: from ?? null },
  };

  const echarts = read(path.join(assetsDir, 'echarts.min.js'));
  const cssText = read(path.join(assetsDir, 'report.css'));
  const runtime = read(path.join(assetsDir, 'report.js'));

  const ambiguousDays = Object.values(cache.used ?? {}).filter((b) => (b.entries ?? []).length > 1).length;
  const balanceText = cache.balance == null ? '未知' : `${cache.balance} 度`;

  return `<!doctype html>
<html lang="zh-CN" data-theme="${esc(theme)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(cache.room)} 用电报告</title>
<style>
${cssText}
</style>
</head>
<body>
<header>
  <h1>${esc(cache.room)} 用电 / 购电报告<span class="tag">${esc(cache.building ?? '')}${cache.floor ? ' · ' + esc(cache.floor) : ''}</span></h1>
  <div class="meta">
    <span>房间编码 <b>${esc(cache.code)}</b></span>
    <span>当前余额 <b>${esc(balanceText)}</b>${cache.acBalance != null ? ` · 空调 <b>${esc(cache.acBalance)} 度</b>` : ''}</span>
    <span>用电记录 <b>${dates.length}</b> 天 · 购电记录 <b>${(cache.buy ?? []).length}</b> 笔</span>
    <span>数据范围 <b>${esc(first)} ~ ${esc(last)}</b></span>
    <span>生成于 <b>${esc(generatedAt.toISOString().slice(0, 16).replace('T', ' '))}</b></span>
  </div>
</header>

<div class="toolbar">
  <div class="seg" id="presets"></div>
  <span class="field">自定义 <input type="date" id="from"> ~ <input type="date" id="to"></span>
  <span class="field">统计粒度
    <select id="agg">
      <option value="day">按日</option>
      <option value="week">按周</option>
      <option value="month">按月</option>
    </select>
  </span>
  <span class="field">同日多值
    <select id="policy">
      <option value="max">取较大值</option>
      <option value="sum">相加</option>
      <option value="min">取较小值</option>
      <option value="first">第一条</option>
      <option value="last">最后一条</option>
    </select>
  </span>
  <span class="spacer"></span>
  <button class="ghost" id="theme">深色</button>
</div>

<div id="notes"></div>
<div class="stats" id="stats"></div>

<figure>
  <figcaption>用电量 <span class="hint">拖动下方滑块或滚轮缩放；按日粒度数据点较多时自动降采样</span></figcaption>
  <div class="chart tall" id="chart-used"></div>
</figure>

<figure>
  <figcaption>购电记录 <span class="hint" id="buy-count"></span></figcaption>
  <div class="chart" id="chart-buy"></div>
</figure>

<figure>
  <figcaption>余额推算 <span class="hint">由当前余额倒推：余额(t) = 当前余额 − 之后的购电 + 之后的用电</span></figcaption>
  <div class="chart" id="chart-balance"></div>
</figure>

<details>
  <summary>用电明细（${dates.length} 天${ambiguousDays ? ` · ${ambiguousDays} 天存在同日多条记录，已标黄` : ''}）</summary>
  <div class="tableWrap" id="table-used"></div>
  <div class="pager" id="pager"></div>
</details>

<details style="margin-top:12px">
  <summary>购电明细（${(cache.buy ?? []).length} 笔）</summary>
  <div class="tableWrap" id="table-buy"></div>
</details>

<footer>
  数据来源：校园用电查询系统 · 本页为离线单文件报告，可直接分享或存档。
  统计口径：用电量为电表日用量，电费为用量 × 当日单价，购电含退款（负数）。
</footer>

<script>${echarts}</script>
<script>window.__REPORT_DATA__ = ${jsonForScript(payload)};</script>
<script>${runtime}</script>
</body>
</html>
`;
}

export function writeReport(file, opts) {
  const html = buildReportHtml(opts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html);
  return { file, bytes: Buffer.byteLength(html) };
}
