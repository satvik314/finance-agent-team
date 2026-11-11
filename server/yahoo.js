// Yahoo Finance proxy.
//
// Yahoo's endpoints can't be called from the browser (no CORS headers, and the
// richer endpoints need a session cookie + "crumb"). This module runs on the
// server side — inside the Vite dev/preview server or the standalone
// production server — and exposes a small JSON API under /api/yf/*.
//
// No API key is required for Yahoo Finance.

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const Q1 = 'https://query1.finance.yahoo.com';
const Q2 = 'https://query2.finance.yahoo.com';

const SYMBOL_RE = /^[A-Za-z0-9.\-^=]{1,20}$/;
const RANGES = new Set(['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'ytd', 'max']);
const INTERVALS = new Set(['1m', '5m', '15m', '30m', '60m', '1h', '1d', '1wk', '1mo']);
const MODULES = new Set([
  'assetProfile',
  'price',
  'summaryDetail',
  'financialData',
  'defaultKeyStatistics',
  'recommendationTrend',
  'upgradeDowngradeHistory',
  'earningsTrend',
  'calendarEvents',
  'earnings',
]);

// ---------------------------------------------------------------- session --

let session = null; // { cookie, crumb, at }
let sessionPromise = null;
const SESSION_TTL = 30 * 60 * 1000;

function cookiesFrom(res) {
  const list =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie')].filter(Boolean);
  return list.map((c) => c.split(';')[0]).filter(Boolean);
}

async function createSession() {
  const cookies = [];
  // fc.yahoo.com answers 404 but sets the A3 cookie Yahoo needs for the crumb.
  for (const url of ['https://fc.yahoo.com/', 'https://finance.yahoo.com/']) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'manual' });
      cookies.push(...cookiesFrom(r));
      if (cookies.length) break;
    } catch {
      /* try the next one */
    }
  }
  const cookie = cookies.join('; ');
  const r = await fetch(`${Q2}/v1/test/getcrumb`, {
    headers: { 'User-Agent': UA, ...(cookie ? { Cookie: cookie } : {}) },
  });
  const crumb = (await r.text()).trim();
  if (!r.ok || !crumb || crumb.length > 64 || crumb.includes('<') || crumb.includes(' ')) {
    throw new HttpError(502, 'Could not start a Yahoo Finance session (crumb unavailable).');
  }
  return { cookie, crumb, at: Date.now() };
}

async function getSession(force = false) {
  if (!force && session && Date.now() - session.at < SESSION_TTL) return session;
  if (!sessionPromise) {
    sessionPromise = createSession()
      .then((s) => (session = s))
      .finally(() => (sessionPromise = null));
  }
  return sessionPromise;
}

// ------------------------------------------------------------------ fetch --

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const cache = new Map(); // url -> { at, ttl, data }
const MAX_CACHE = 300;

async function yahooJson(url, { crumb = false, ttl = 60_000 } = {}) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.data;

  for (let attempt = 0; attempt < 2; attempt++) {
    let finalUrl = url;
    const headers = { 'User-Agent': UA, Accept: 'application/json' };
    if (crumb) {
      const s = await getSession(attempt > 0);
      finalUrl += `${url.includes('?') ? '&' : '?'}crumb=${encodeURIComponent(s.crumb)}`;
      if (s.cookie) headers.Cookie = s.cookie;
    }
    const r = await fetch(finalUrl, { headers });
    if (crumb && (r.status === 401 || r.status === 403) && attempt === 0) continue; // refresh crumb
    let data;
    try {
      data = await r.json();
    } catch {
      throw new HttpError(502, `Yahoo Finance returned a non-JSON response (HTTP ${r.status}).`);
    }
    if (!r.ok) {
      const msg =
        data?.chart?.error?.description ||
        data?.quoteSummary?.error?.description ||
        data?.finance?.error?.description ||
        `Yahoo Finance request failed (HTTP ${r.status}).`;
      throw new HttpError(r.status === 404 ? 404 : 502, msg);
    }
    if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
    cache.set(url, { at: Date.now(), ttl, data });
    return data;
  }
  throw new HttpError(502, 'Yahoo Finance rejected the session.');
}

// ----------------------------------------------------------------- routes --

function symbolParam(params) {
  const s = (params.get('symbol') || '').trim().toUpperCase();
  if (!SYMBOL_RE.test(s)) throw new HttpError(400, 'Invalid or missing "symbol".');
  return s;
}

function intParam(params, name, def, min, max) {
  const n = Number.parseInt(params.get(name) ?? '', 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

const routes = {
  // Price history + current quote metadata. No crumb needed.
  async chart(p) {
    const symbol = symbolParam(p);
    const range = RANGES.has(p.get('range')) ? p.get('range') : '1mo';
    const interval = INTERVALS.has(p.get('interval')) ? p.get('interval') : '1d';
    const data = await yahooJson(
      `${Q1}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false&events=div%2Csplits`,
      { ttl: 60_000 },
    );
    const result = data?.chart?.result?.[0];
    if (!result) throw new HttpError(404, `No price data found for ${symbol}.`);
    return result;
  },

  // Company profile, fundamentals, ratios, analyst data. Needs crumb.
  async summary(p) {
    const symbol = symbolParam(p);
    const modules = (p.get('modules') || 'price')
      .split(',')
      .map((m) => m.trim())
      .filter((m) => MODULES.has(m));
    if (!modules.length) throw new HttpError(400, 'No valid "modules" requested.');
    const data = await yahooJson(
      `${Q2}/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules.join('%2C')}&formatted=true&lang=en-US&region=US`,
      { crumb: true, ttl: 5 * 60_000 },
    );
    const result = data?.quoteSummary?.result?.[0];
    if (!result) throw new HttpError(404, `No company data found for ${symbol}.`);
    return result;
  },

  // Ticker lookup + latest news headlines. No crumb needed.
  async search(p) {
    const q = (p.get('q') || '').trim().slice(0, 80);
    if (!q) throw new HttpError(400, 'Missing "q".');
    const newsCount = intParam(p, 'newsCount', 8, 0, 25);
    const quotesCount = intParam(p, 'quotesCount', 6, 0, 20);
    const data = await yahooJson(
      `${Q1}/v1/finance/search?q=${encodeURIComponent(q)}&newsCount=${newsCount}&quotesCount=${quotesCount}&enableFuzzyQuery=false&lang=en-US&region=US`,
      { ttl: 3 * 60_000 },
    );
    return { quotes: data?.quotes ?? [], news: data?.news ?? [] };
  },

  // Trending tickers for a region. No crumb needed.
  async trending(p) {
    const region = /^[A-Z]{2}$/.test(p.get('region') || '') ? p.get('region') : 'US';
    const data = await yahooJson(`${Q1}/v1/finance/trending/${region}?count=15`, { ttl: 5 * 60_000 });
    return { region, quotes: data?.finance?.result?.[0]?.quotes ?? [] };
  },

  async health() {
    return { ok: true, service: 'yahoo-finance-proxy' };
  },
};

// ---------------------------------------------------------------- handler --

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

/**
 * Connect/Node-style middleware: handles GET /api/yf/<route>?...
 * Anything else is passed to `next` (or answered 404 when there is no next).
 */
export async function yahooHandler(req, res, next) {
  const url = new URL(req.url, 'http://localhost');
  const match = url.pathname.match(/^\/api\/yf\/([a-z]+)\/?$/);
  if (!match) return next ? next() : send(res, 404, { error: 'Not found' });

  const route = routes[match[1]];
  if (!route) return send(res, 404, { error: `Unknown endpoint "${match[1]}".` });
  if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });

  try {
    send(res, 200, await route(url.searchParams));
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 502;
    const message =
      err instanceof HttpError ? err.message : `Could not reach Yahoo Finance: ${err?.message || err}`;
    send(res, status, { error: message });
  }
}

/** Vite plugin: mounts the proxy in both `vite` (dev) and `vite preview`. */
export function financeApiPlugin() {
  return {
    name: 'finance-api',
    configureServer(server) {
      server.middlewares.use(yahooHandler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(yahooHandler);
    },
  };
}
