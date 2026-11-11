# Finance Agent Team

A personal finance **multi-agent** app built with **Vite** (vanilla JS). You ask a question about a stock, ETF, crypto or a money topic. A **Team Leader** agent sends parts of the work to specialist agents, running them in parallel, then streams back a plain-English answer with sources.

It's a JavaScript version of this Python [agno](https://github.com/agno-agi/agno) setup: `Agent`, `Team` and `YFinanceTools` with the same flags, plus **live internet access** through Google Search.

| Agent | Tools | Job |
|---|---|---|
| **Team Leader** | `delegate_task_to_member` | Plans the work, delegates to members in parallel and writes the final report |
| **Web Researcher** | Google Search grounding | Latest internet news, earnings coverage, macro and market context |
| **Company News Researcher** | Yahoo Finance: news, company info, symbol search, trending tickers | Company headlines and profile |
| **Financial Analyst** | Yahoo Finance: price, history, fundamentals, key ratios, analyst recommendations, symbol search | The numbers |

## Features

- **Bring your own key.** You enter your Gemini API key in the UI. The browser sends it straight to Google and never to this app's server. By default it's kept in `sessionStorage`. Tick "Remember" to keep it in `localStorage` instead.
- **Model picker.** "Check key & load models" lists the Gemini models your key can use. If the default (`gemini-3.8-flash`, from the original Python code) isn't available, it switches to one that is.
- **Yahoo Finance with no key.** A small built-in proxy handles Yahoo's cookie/crumb handshake and the lack of CORS support.
- **Streaming answers** rendered as Markdown, with a **Sources** list built from Google Search grounding and Yahoo news links.
- **Live activity panel.** It shows each delegation, tool call (with its arguments), web search query and error as it happens.
- **Market snapshot** cards with price, daily change and a sparkline.
- **Follow-up questions** keep the conversation context. "Concise" (180–220 words) and "Detailed" report modes. Stop button. Works on mobile.
- **Graceful degradation.** If one tool fails, the agent skips that data and carries on, and never invents numbers.

## Quick start

```bash
npm install
npm run dev
```

Open http://localhost:5173, click **API keys**, paste a Gemini key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey), then ask something like *"Research NVIDIA (NVDA): key numbers, recent news, growth opportunities and risks."*

### Production

```bash
npm run build
npm start          # serves dist/ + the Yahoo proxy on PORT (default 3000)
```

`npm run preview` also works, because the proxy is mounted in Vite's preview server too.

> The Yahoo Finance proxy needs a Node server. A purely static host (GitHub Pages, a plain S3 bucket) can't run it. Deploy `npm start` to a Node host such as Render, Railway, Fly.io or a VPS. Alternatively, port `server/yahoo.js`'s `yahooHandler` to a serverless function at `/api/yf/*`.

## Project structure

```
index.html                  App shell
vite.config.js              Mounts the Yahoo proxy in dev + preview
server/
  yahoo.js                  Yahoo Finance proxy (cookie/crumb, caching, validation) + Vite plugin
  index.js                  Zero-dependency production server
src/
  agents/
    agent.js                Agent (tool loop) and Team (leader + parallel delegation, streaming)
    yfinance-tools.js       YFinanceTools({ enable_stock_price: true, ... }) — Gemini function tools
    team.js                 The team definition — mirrors the original Python code
  lib/
    gemini.js               Gemini REST client (generate, SSE streaming, list models, grounding sources)
    yahoo.js                Browser client for /api/yf/*
    settings.js             Key + preference storage
    markdown.js             marked + DOMPurify
  ui/sparkline.js           SVG sparkline
  main.js                   UI wiring
  style.css                 Styles (light + dark)
```

## How it maps to the Python version

```python
news_researcher = Agent(name="Company News Researcher", tools=[YFinanceTools(enable_company_news=True, ...)])
research_team = Team(name="Stock Research Team", members=[news_researcher, quant_analyst], ...)
```

```js
export const newsResearcher = new Agent({
  id: 'news_researcher',
  name: 'Company News Researcher',
  tools: YFinanceTools({ enable_company_news: true, enable_company_info: true, ... }),
  instructions: [...],
});
new Team({ name: 'Personal Finance Agent Team', members: [webResearcher, newsResearcher, quantAnalyst], ... });
```

To add a member, create a new `Agent` in `src/agents/team.js` and add it to `MEMBERS`. The leader learns about it automatically.

## Yahoo proxy endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/yf/chart?symbol=NVDA&range=1y&interval=1d` | Price history + current quote |
| `GET /api/yf/summary?symbol=NVDA&modules=price,financialData,...` | Profile, fundamentals, ratios, analyst data (whitelisted modules) |
| `GET /api/yf/search?q=nvidia&newsCount=8` | Ticker lookup + news |
| `GET /api/yf/trending?region=US` | Trending tickers |
| `GET /api/yf/health` | Proxy health check |

Yahoo Finance is an unofficial data source. Its endpoints can change or rate-limit without notice.

## Disclaimer

This app gives educational information, not financial advice. AI agents can make mistakes, so check important numbers before you act on them.
