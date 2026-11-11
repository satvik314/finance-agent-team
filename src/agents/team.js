// The finance agent team — the JavaScript counterpart of the Python/agno setup:
// Company News Researcher + Financial Analyst (Yahoo Finance tools),
// plus a Web Researcher with live internet access, led by a Team Leader.

import { Agent, Team } from './agent.js';
import { YFinanceTools } from './yfinance-tools.js';

// 1. Web Researcher — live internet access through Google Search grounding.
export const webResearcher = new Agent({
  id: 'web_researcher',
  name: 'Web Researcher',
  role: 'Search the internet for the latest news, market context, earnings coverage, macro events and anything not in Yahoo Finance.',
  googleSearch: true,
  instructions: [
    `Search the web for the most recent, relevant information for the task. Prefer reputable
    financial and news sources and say when each development happened. Summarise the findings
    in simple language with bullet points. Never invent facts; if you find nothing reliable, say so.`,
  ],
});

// 2. Company News Researcher
export const newsResearcher = new Agent({
  id: 'news_researcher',
  name: 'Company News Researcher',
  role: 'Find and summarize available company news and company information from Yahoo Finance.',
  tools: YFinanceTools({
    enable_company_news: true,
    enable_company_info: true,
    enable_symbol_search: true,
    enable_trending_tickers: true,
  }),
  instructions: [
    `Find and summarize available company news in simple language.
    If news is unavailable, continue using any other available company
    information. Never invent facts. Provide a useful answer with whatever
    information is available. If you only have a company name, look up its ticker first.`,
  ],
});

// 3. Financial Analyst
export const quantAnalyst = new Agent({
  id: 'financial_analyst',
  name: 'Financial Analyst',
  role: 'Analyze available stock prices, price history, fundamentals, key ratios and analyst recommendations.',
  tools: YFinanceTools({
    enable_stock_price: true,
    enable_historical_prices: true,
    enable_analyst_recommendations: true,
    enable_company_info: true,
    enable_stock_fundamentals: true,
    enable_key_financial_ratios: true,
    enable_symbol_search: true,
  }),
  instructions: [
    `Analyze available stock prices, financial statistics, and analyst
    recommendations. Explain the findings in simple language. If any data
    is missing or a tool fails, skip that item and continue with the data
    you have. Never invent numbers or claim unavailable data is current.
    If you only have a company name, look up its ticker first.`,
  ],
});

export const MEMBERS = [webResearcher, newsResearcher, quantAnalyst];

export const REPORT_STYLES = {
  concise: 'Keep stock reports to 180–220 words.',
  detailed: 'Stock reports may run 400–600 words, with a short table of key numbers where useful.',
};

// 4. Research Team Leader
export function createTeam() {
  return new Team({
    name: 'Personal Finance Agent Team',
    members: MEMBERS,
    instructions: [
      `Create clear answers and stock reports for everyday readers.
      For a stock report, cover the overview, key numbers, recent news, growth opportunities,
      risks, and conclusion when available. Use simple language and concise bullets. Skip missing data.
      Give the most useful answer possible without inventing facts or guaranteeing returns.`,
    ],
  });
}
