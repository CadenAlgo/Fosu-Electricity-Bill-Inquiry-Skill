/**
 * Low-level HTTP client for the campus electricity site.
 *
 * The site is a legacy ASP.NET WebForms app with three quirks that must be
 * handled or every query silently returns an empty result page:
 *
 *  1. Mixed charset. `Default.aspx` is served as GB2312 while
 *     `usedRecord.aspx` / `buyRecord.aspx` are UTF-8, and the HTML <meta> tag
 *     lies (it says utf-8 on the GB2312 page). We trust the HTTP header first.
 *  2. A session cookie (`ASP.NET_SessionId`) is issued only on the room
 *     postback, and the result page reads the selection back from that session.
 *     Without a cookie jar the redirect to the record page bounces to the login
 *     form.
 *  3. The room postback answers with a 302 and expects the caller to fetch the
 *     redirect target. Plain `redirect: 'follow'` loses the POST context, so we
 *     follow manually.
 */

/** The campus electricity query service. */
export const DEFAULT_BASE = 'http://10.10.60.223:8010/';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const decoders = new Map();
function decoderFor(label) {
  const key = label === 'gb2312' || label === 'gb-2312' ? 'gbk' : label;
  if (!decoders.has(key)) decoders.set(key, new TextDecoder(key));
  return decoders.get(key);
}

/** Decode a response body using the HTTP charset, falling back to a meta sniff. */
export function decodeBody(buf, contentType) {
  let label = /charset=["']?([\w-]+)/i.exec(contentType || '')?.[1];
  if (!label) {
    const head = buf.subarray(0, 4096).toString('latin1');
    label = /charset=["']?([\w-]+)/i.exec(head)?.[1] || 'utf-8';
  }
  try {
    return decoderFor(label.toLowerCase()).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

export class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** Process-wide counters used for progress reporting and speed diagnosis. */
export const httpStats = {
  attempts: 0,
  errors: 0,
  retries: 0,
  totalMs: 0,
  maxMs: 0,
  byStatus: Object.create(null),
  byError: Object.create(null),
  reset() {
    this.attempts = 0; this.errors = 0; this.retries = 0;
    this.totalMs = 0; this.maxMs = 0;
    this.byStatus = Object.create(null); this.byError = Object.create(null);
  },
  get avgMs() { return this.attempts ? this.totalMs / this.attempts : 0; },
};

export class Client {
  constructor({ base, timeoutMs = 60000 } = {}) {
    this.base = base;
    this.timeoutMs = timeoutMs;
    this.jar = new Map();
  }

  url(path) {
    return path.startsWith('http') ? path : this.base + String(path).replace(/^\//, '');
  }

  async request(path, opts = {}) {
    const url = this.url(path);
    const headers = {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      ...(opts.headers || {}),
    };
    if (this.jar.size) headers.Cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');

    const started = Date.now();
    httpStats.attempts++;
    let res;
    try {
      res = await fetch(url, {
        ...opts,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs),
      });
    } catch (err) {
      const kind = err?.name === 'TimeoutError' ? 'timeout' : err?.cause?.code ?? err?.code ?? err?.name ?? 'unknown';
      httpStats.errors++;
      httpStats.byError[kind] = (httpStats.byError[kind] ?? 0) + 1;
      const ms = Date.now() - started;
      httpStats.totalMs += ms;
      if (ms > httpStats.maxMs) httpStats.maxMs = ms;
      throw err;
    }
    const ms = Date.now() - started;
    httpStats.totalMs += ms;
    if (ms > httpStats.maxMs) httpStats.maxMs = ms;
    httpStats.byStatus[res.status] = (httpStats.byStatus[res.status] ?? 0) + 1;

    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) this.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }

    const buf = Buffer.from(await res.arrayBuffer());
    return {
      status: res.status,
      location: res.headers.get('location'),
      text: decodeBody(buf, res.headers.get('content-type')),
      bytes: buf.length,
    };
  }

  get(path, opts) {
    return this.request(path, { ...opts, method: 'GET' });
  }

  post(path, body, opts) {
    return this.request(path, {
      ...opts,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(opts?.headers || {}) },
      body: new URLSearchParams(body).toString(),
    });
  }
}

/* ------------------------------------------------------------------ parsing */

/** Collect every `<input type="hidden">` name/value pair from an ASP.NET page. */
export function hiddenFields(html) {
  const out = {};
  const re = /<input[^>]*type="hidden"[^>]*>/gi;
  for (const [tag] of html.matchAll(re)) {
    const name = /\bname="([^"]*)"/i.exec(tag)?.[1];
    const value = /\bvalue="([^"]*)"/i.exec(tag)?.[1] ?? '';
    if (name) out[name] = value;
  }
  return out;
}

/** Read the `<option>` list of a `<select name="...">`. */
export function selectOptions(html, name) {
  const block = new RegExp(`<select[^>]*name="${name}"[^>]*>([\\s\\S]*?)</select>`, 'i').exec(html);
  if (!block) return [];
  const out = [];
  for (const [, value, label] of block[1].matchAll(/<option[^>]*value="([^"]*)"[^>]*>([^<]*)<\/option>/gi)) {
    out.push({ value, label: decodeEntities(label) });
  }
  return out;
}

/** `第 1 页 / 共 229 页 每页 10 条` -> { page, totalPages, perPage } */
export function pageInfo(html) {
  const m = /第\s*(\d+)\s*页\s*\/\s*共\s*(\d+)\s*页\s*每页\s*(\d+)\s*条/.exec(html);
  return m ? { page: Number(m[1]), totalPages: Number(m[2]), perPage: Number(m[3]) } : null;
}

/** Rows of `table.dataTable`, header row excluded. */
export function tableRows(html) {
  const table = /<table[^>]*class="dataTable"[^>]*>([\s\S]*?)<\/table>/i.exec(html);
  if (!table) return [];
  const out = [];
  for (const [row] of table[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    if (/titleLine/i.test(row) && !/<td/i.test(row.replace(/class="titleLine"/i, ''))) continue;
    if (/class="titleLine"/i.test(row)) continue;
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) =>
      decodeEntities(c[1].replace(/<[^>]*>/g, '')).trim()
    );
    if (cells.length) out.push(cells);
  }
  return out;
}

/** `D1-101剩余电量：87.70 度   空调：0 度` -> { balance, acBalance } */
export function balanceFromBanner(html) {
  const h6 = /<h6>([\s\S]*?)<\/h6>/i.exec(html)?.[1];
  if (!h6) return { balance: null, acBalance: null, text: null };
  const text = decodeEntities(h6.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
  const num = (re) => {
    const m = re.exec(text);
    return m ? Number(m[1]) : null;
  };
  return {
    balance: num(/(?:剩余电量|剩余金额)[：:]\s*(-?[\d.]+)/),
    acBalance: num(/空调[：:]\s*(-?[\d.]+)/),
    text,
  };
}

export function decodeEntities(s) {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
}

/* ------------------------------------------------------------------- retry */

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Retry an async operation with exponential backoff; rethrows the last error. */
export async function withRetry(fn, { attempts = 4, baseDelayMs = 300, label = 'request' } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const value = await fn(i);
      if (value && typeof value === 'object' && 'status' in value && value.status >= 500) {
        throw new HttpError(`${label}: HTTP ${value.status}`, value.status);
      }
      return value;
    } catch (err) {
      lastErr = err;
      if (i < attempts) {
        httpStats.retries++;
        await sleep(baseDelayMs * i + Math.random() * 150);
      }
    }
  }
  throw lastErr;
}
