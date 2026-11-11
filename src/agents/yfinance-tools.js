// YFinanceTools — a JavaScript take on agno.tools.yfinance.YFinanceTools.
// Each tool = a Gemini function declaration + an implementation that calls the
// local Yahoo Finance proxy and returns compact, LLM-friendly JSON.
//
// Tools never throw: failures come back as { error } so an agent can skip the
// missing piece and keep going ("If any data is missing or a tool fails, skip
// that item and continue").

import { yf } from '../lib/yahoo.js';

const SYMBOL = { type: 'string', description: 'Ticker symbol, e.g. NVDA, AAPL, RELIANCE.NS, BTC-USD.' };

// Yahoo quoteSummary values look like { raw: 123.4, fmt: "123.40" }.
const val = (x) => (x && typeof x === 'object' && ('raw' in x || 'fmt' in x) ? (x.fmt ?? x.raw) : x);
const num = (x) => (x && typeof x === 'object' && 'raw' in x ? x.raw : typeof x === 'number' ? x : undefined);

/** Drops null/undefined/empty values so the model only sees real data. */
function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const x = val(v);
    if (x === undefined || x === null || x === '' || (typeof x === 'object' && !Object.keys(x).length)) continue;
    out[k] = x;
  }
  return out;
}

const iso = (sec) => (sec ? new Date(sec * 1000).toISOString() : undefined);
const round = (n, d = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : undefined);
const sym = (s) => String(s || '').trim().toUpperCase();

async function summary(symbol, modules, signal) {
  return yf('summary', { symbol: sym(symbol), modules: modules.join(',') }, signal);
}

function seriesFrom(chart) {
  const ts = chart.timestamp ?? [];
  const q = chart.indicators?.quote?.[0] ?? {};
  const adj = chart.indicators?.adjclose?.[0]?.adjclose;
  return ts
    .map((t, i) => ({
      t: t * 1000,
      open: q.open?.[i],
      high: q.high?.[i],
      low: q.low?.[i],
      close: adj?.[i] ?? q.close?.[i],
      volume: q.volume?.[i],
    }))
    .filter((p) => Number.isFinite(p.close));
}

// ----------------------------------------------------------------- tools --

const tools = {
  search_symbol: {
    declaration: {
      name: 'search_symbol',
      description:
        'Look up ticker symbols by company, fund or crypto name (e.g. "Nvidia", "Vanguard S&P 500"). Use this when the ticker is unknown.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Company, fund or asset name.' } },
        required: ['query'],
      },
    },
    async run({ query }, { signal }) {
      const data = await yf('search', { q: query, quotesCount: 8, newsCount: 0 }, signal);
      return {
        matches: data.quotes
          .filter((q) => q.symbol)
          .map((q) =>
            clean({
              symbol: q.symbol,
              name: q.longname || q.shortname,
              type: q.quoteType,
              exchange: q.exchDisp || q.exchange,
              sector: q.sectorDisp,
            }),
          ),
      };
    },
  },

  get_current_stock_price: {
    declaration: {
      name: 'get_current_stock_price',
      description: 'Get the latest market price, daily change, day range, volume and 52-week range for a ticker.',
      parameters: { type: 'object', properties: { symbol: SYMBOL }, required: ['symbol'] },
    },
    async run({ symbol }, { signal, emit }) {
      const chart = await yf('chart', { symbol: sym(symbol), range: '1mo', interval: '1d' }, signal);
      const m = chart.meta ?? {};
      const series = seriesFrom(chart);
      const price = m.regularMarketPrice ?? series.at(-1)?.close;
      const prev = series.length > 1 ? series.at(-2).close : m.chartPreviousClose ?? m.previousClose;
      const change = Number.isFinite(price) && Number.isFinite(prev) ? price - prev : undefined;
      const result = clean({
        symbol: m.symbol || sym(symbol),
        name: m.longName || m.shortName,
        currency: m.currency,
        exchange: m.fullExchangeName || m.exchangeName,
        price: round(price, 4),
        previous_close: round(prev, 4),
        change: round(change, 4),
        change_percent: Number.isFinite(change) && prev ? round((change / prev) * 100) : undefined,
        day_high: m.regularMarketDayHigh,
        day_low: m.regularMarketDayLow,
        volume: m.regularMarketVolume,
        fifty_two_week_high: m.fiftyTwoWeekHigh,
        fifty_two_week_low: m.fiftyTwoWeekLow,
        as_of: iso(m.regularMarketTime),
      });
      emit?.({ type: 'quote', quote: result, series: series.map((p) => ({ t: p.t, close: p.close })) });
      return result;
    },
  },

  get_historical_stock_prices: {
    declaration: {
      name: 'get_historical_stock_prices',
      description:
        'Get historical closing prices for a ticker over a period, with a performance summary (return, high, low, volatility).',
      parameters: {
        type: 'object',
        properties: {
          symbol: SYMBOL,
          period: {
            type: 'string',
            enum: ['5d', '1mo', '3mo', '6mo', 'ytd', '1y', '2y', '5y', '10y', 'max'],
            description: 'Look-back period. Default 1y.',
          },
        },
        required: ['symbol'],
      },
    },
    async run({ symbol, period = '1y' }, { signal, emit }) {
      const interval = ['5y', '10y', 'max'].includes(period) ? '1wk' : period === '5d' ? '1h' : '1d';
      const chart = await yf('chart', { symbol: sym(symbol), range: period, interval }, signal);
      const s = seriesFrom(chart);
      if (!s.length) return { error: `No price history for ${sym(symbol)}.` };
      const closes = s.map((p) => p.close);
      const rets = closes.slice(1).map((c, i) => c / closes[i] - 1);
      const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
      const sd = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length || 1));
      const perYear = interval === '1wk' ? 52 : interval === '1h' ? 252 * 7 : 252;
      // Sample at most ~40 points for the model; the UI gets the full series.
      const step = Math.max(1, Math.ceil(s.length / 40));
      const sampled = s.filter((_, i) => i % step === 0 || i === s.length - 1);
      emit?.({
        type: 'history',
        symbol: chart.meta?.symbol || sym(symbol),
        currency: chart.meta?.currency,
        period,
        series: s.map((p) => ({ t: p.t, close: p.close })),
      });
      return {
        symbol: chart.meta?.symbol || sym(symbol),
        currency: chart.meta?.currency,
        period,
        interval,
        start: { date: new Date(s[0].t).toISOString().slice(0, 10), close: round(closes[0]) },
        end: { date: new Date(s.at(-1).t).toISOString().slice(0, 10), close: round(closes.at(-1)) },
        total_return_percent: round((closes.at(-1) / closes[0] - 1) * 100),
        period_high: round(Math.max(...closes)),
        period_low: round(Math.min(...closes)),
        annualized_volatility_percent: round(sd * Math.sqrt(perYear) * 100),
        closes: sampled.map((p) => [new Date(p.t).toISOString().slice(0, 10), round(p.close)]),
      };
    },
  },

  get_company_info: {
    declaration: {
      name: 'get_company_info',
      description:
        'Get a company profile and overview: name, sector, industry, business summary, employees, website, market cap and headline valuation.',
      parameters: { type: 'object', properties: { symbol: SYMBOL }, required: ['symbol'] },
    },
    async run({ symbol }, { signal }) {
      const d = await summary(symbol, ['assetProfile', 'price', 'summaryDetail', 'financialData'], signal);
      const a = d.assetProfile ?? {};
      const p = d.price ?? {};
      const s = d.summaryDetail ?? {};
      const f = d.financialData ?? {};
      const about = a.longBusinessSummary;
      return clean({
        symbol: p.symbol || sym(symbol),
        name: p.longName || p.shortName,
        type: p.quoteType,
        sector: a.sector,
        industry: a.industry,
        country: a.country,
        website: a.website,
        employees: a.fullTimeEmployees,
        summary: about && about.length > 900 ? `${about.slice(0, 900)}…` : about,
        currency: p.currency,
        price: p.regularMarketPrice,
        market_cap: p.marketCap ?? s.marketCap,
        trailing_pe: s.trailingPE,
        forward_pe: s.forwardPE,
        dividend_yield: s.dividendYield,
        fifty_two_week_low: s.fiftyTwoWeekLow,
        fifty_two_week_high: s.fiftyTwoWeekHigh,
        recommendation: f.recommendationKey,
      });
    },
  },

  get_stock_fundamentals: {
    declaration: {
      name: 'get_stock_fundamentals',
      description:
        'Get fundamental data: market cap, P/E, forward P/E, PEG, price/book, EPS, revenue, earnings, dividend, beta and 52-week range.',
      parameters: { type: 'object', properties: { symbol: SYMBOL }, required: ['symbol'] },
    },
    async run({ symbol }, { signal }) {
      const d = await summary(symbol, ['price', 'summaryDetail', 'defaultKeyStatistics', 'financialData'], signal);
      const p = d.price ?? {};
      const s = d.summaryDetail ?? {};
      const k = d.defaultKeyStatistics ?? {};
      const f = d.financialData ?? {};
      return clean({
        symbol: p.symbol || sym(symbol),
        name: p.longName || p.shortName,
        currency: f.financialCurrency || p.currency,
        market_cap: p.marketCap ?? s.marketCap,
        enterprise_value: k.enterpriseValue,
        trailing_pe: s.trailingPE,
        forward_pe: s.forwardPE ?? k.forwardPE,
        peg_ratio: k.pegRatio,
        price_to_book: k.priceToBook,
        price_to_sales: s.priceToSalesTrailing12Months,
        trailing_eps: k.trailingEps,
        forward_eps: k.forwardEps,
        total_revenue: f.totalRevenue,
        revenue_per_share: f.revenuePerShare,
        ebitda: f.ebitda,
        net_income: k.netIncomeToCommon,
        total_cash: f.totalCash,
        total_debt: f.totalDebt,
        dividend_rate: s.dividendRate,
        dividend_yield: s.dividendYield,
        payout_ratio: s.payoutRatio,
        beta: s.beta ?? k.beta,
        shares_outstanding: k.sharesOutstanding,
        fifty_two_week_low: s.fiftyTwoWeekLow,
        fifty_two_week_high: s.fiftyTwoWeekHigh,
        fifty_day_average: s.fiftyDayAverage,
        two_hundred_day_average: s.twoHundredDayAverage,
        most_recent_quarter: k.mostRecentQuarter,
      });
    },
  },

  get_key_financial_ratios: {
    declaration: {
      name: 'get_key_financial_ratios',
      description:
        'Get key financial ratios: margins, return on equity/assets, growth, debt-to-equity, liquidity ratios, cash flow and EV multiples.',
      parameters: { type: 'object', properties: { symbol: SYMBOL }, required: ['symbol'] },
    },
    async run({ symbol }, { signal }) {
      const d = await summary(symbol, ['financialData', 'defaultKeyStatistics'], signal);
      const f = d.financialData ?? {};
      const k = d.defaultKeyStatistics ?? {};
      return clean({
        symbol: sym(symbol),
        gross_margin: f.grossMargins,
        operating_margin: f.operatingMargins,
        ebitda_margin: f.ebitdaMargins,
        profit_margin: f.profitMargins ?? k.profitMargins,
        return_on_equity: f.returnOnEquity,
        return_on_assets: f.returnOnAssets,
        revenue_growth_yoy: f.revenueGrowth,
        earnings_growth_yoy: f.earningsGrowth,
        quarterly_earnings_growth: k.earningsQuarterlyGrowth,
        debt_to_equity: f.debtToEquity,
        current_ratio: f.currentRatio,
        quick_ratio: f.quickRatio,
        free_cash_flow: f.freeCashflow,
        operating_cash_flow: f.operatingCashflow,
        ev_to_revenue: k.enterpriseToRevenue,
        ev_to_ebitda: k.enterpriseToEbitda,
      });
    },
  },

  get_analyst_recommendations: {
    declaration: {
      name: 'get_analyst_recommendations',
      description:
        'Get Wall Street analyst consensus: buy/hold/sell counts by month, price targets, and recent upgrades/downgrades.',
      parameters: { type: 'object', properties: { symbol: SYMBOL }, required: ['symbol'] },
    },
    async run({ symbol }, { signal }) {
      const d = await summary(
        symbol,
        ['recommendationTrend', 'financialData', 'upgradeDowngradeHistory', 'price'],
        signal,
      );
      const f = d.financialData ?? {};
      const price = num(f.currentPrice) ?? num(d.price?.regularMarketPrice);
      const target = num(f.targetMeanPrice);
      return clean({
        symbol: sym(symbol),
        consensus: f.recommendationKey,
        consensus_score: f.recommendationMean, // 1 = strong buy … 5 = strong sell
        analyst_count: f.numberOfAnalystOpinions,
        current_price: f.currentPrice,
        target_mean_price: f.targetMeanPrice,
        target_median_price: f.targetMedianPrice,
        target_high_price: f.targetHighPrice,
        target_low_price: f.targetLowPrice,
        implied_upside_percent: price && target ? round((target / price - 1) * 100) : undefined,
        monthly_trend: (d.recommendationTrend?.trend ?? []).map((t) =>
          clean({
            period: t.period, // 0m = current month, -1m = last month…
            strong_buy: t.strongBuy,
            buy: t.buy,
            hold: t.hold,
            sell: t.sell,
            strong_sell: t.strongSell,
          }),
        ),
        recent_rating_changes: (d.upgradeDowngradeHistory?.history ?? []).slice(0, 8).map((h) =>
          clean({
            date: iso(num(h.epochGradeDate) ?? h.epochGradeDate)?.slice(0, 10),
            firm: h.firm,
            action: h.action,
            from: h.fromGrade,
            to: h.toGrade,
          }),
        ),
      });
    },
  },

  get_company_news: {
    declaration: {
      name: 'get_company_news',
      description: 'Get the latest news headlines about a company or ticker from Yahoo Finance, with links and dates.',
      parameters: {
        type: 'object',
        properties: {
          symbol: SYMBOL,
          num_stories: { type: 'integer', description: 'How many stories (1-15). Default 8.' },
        },
        required: ['symbol'],
      },
    },
    async run({ symbol, num_stories = 8 }, { signal, addSources }) {
      const n = Math.min(15, Math.max(1, Number(num_stories) || 8));
      const data = await yf('search', { q: sym(symbol), newsCount: n, quotesCount: 0 }, signal);
      const news = data.news.slice(0, n).map((x) =>
        clean({
          title: x.title,
          publisher: x.publisher,
          published: iso(x.providerPublishTime),
          link: x.link,
          related_tickers: x.relatedTickers?.join(', '),
        }),
      );
      addSources?.(news.filter((x) => x.link).map((x) => ({ title: x.title, url: x.link })));
      return news.length ? { symbol: sym(symbol), news } : { symbol: sym(symbol), news: [], note: 'No news found.' };
    },
  },

  get_trending_tickers: {
    declaration: {
      name: 'get_trending_tickers',
      description: 'Get the tickers currently trending on Yahoo Finance for a region (default US).',
      parameters: {
        type: 'object',
        properties: { region: { type: 'string', description: 'Two-letter region code, e.g. US, IN, GB. Default US.' } },
      },
    },
    async run({ region = 'US' }, { signal }) {
      const data = await yf('trending', { region: String(region).toUpperCase() }, signal);
      return { region: data.region, symbols: data.quotes.map((q) => q.symbol).filter(Boolean) };
    },
  },
};

/**
 * Mirrors the Agno constructor flags, e.g.
 *   YFinanceTools({ enable_stock_price: true, enable_company_news: true })
 */
export function YFinanceTools(flags = {}) {
  const map = {
    enable_symbol_search: ['search_symbol'],
    enable_stock_price: ['get_current_stock_price'],
    enable_historical_prices: ['get_historical_stock_prices'],
    enable_company_info: ['get_company_info'],
    enable_stock_fundamentals: ['get_stock_fundamentals'],
    enable_key_financial_ratios: ['get_key_financial_ratios'],
    enable_analyst_recommendations: ['get_analyst_recommendations'],
    enable_company_news: ['get_company_news'],
    enable_trending_tickers: ['get_trending_tickers'],
  };
  const names = new Set(
    flags.all ? Object.values(map).flat() : Object.entries(map).flatMap(([flag, n]) => (flags[flag] ? n : [])),
  );
  return [...names].map((name) => ({ name, ...tools[name] }));
}
