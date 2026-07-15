// POPPA'S Vertical Credit Spread Scanner — Netlify Function
// Local deterministic scanner (no external Render redirect).
'use strict';

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const ALPHA_BASE_URL = 'https://www.alphavantage.co/query';
const API_KEY = String(process.env.ALPHA_VANTAGE_API_KEY || '').trim();

const j = (body, status = 200) => ({
  statusCode: status,
  headers: CORS,
  body: JSON.stringify(body),
});

function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

function seededUnit(seed, salt) {
  const x = Math.sin(seed * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function parseTickers(input) {
  if (Array.isArray(input)) {
    return [...new Set(input.map((v) => String(v || '').toUpperCase().trim()).filter(Boolean))].slice(0, 100);
  }
  return [...new Set(String(input || '').toUpperCase().split(/[\s,;]+/).map((v) => v.trim()).filter(Boolean))].slice(0, 100);
}

function expirationFromDte(dte) {
  const date = new Date();
  date.setDate(date.getDate() + dte);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function isMonthlyExpiration(date) {
  return date.getDay() === 5 && date.getDate() >= 15 && date.getDate() <= 21;
}

function monthlyDtesInRange(dteMin, dteMax) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const matches = [];
  for (let dte = dteMin; dte <= dteMax; dte += 1) {
    const probe = new Date(today);
    probe.setDate(today.getDate() + dte);
    if (isMonthlyExpiration(probe)) matches.push(dte);
  }
  return matches;
}

function createCandidate(ticker, index, cfg, livePrice = null, priceTimestamp = null) {
  const seed = hashString(ticker + '-' + cfg.strategy + '-' + cfg.dte_min + '-' + cfg.dte_max);
  const syntheticPrice = Math.round(45 + seededUnit(seed, 2) * 420);
  const price = livePrice || syntheticPrice;
  const priceSource = livePrice ? 'alpha-vantage' : 'synthetic';
  const rawBias = seededUnit(seed, 4) * 1.7 - 0.85;
  const biasScore = Math.max(-1, Math.min(1, rawBias));
  const forceBull = cfg.strategy === 'bull_put';
  const forceBear = cfg.strategy === 'bear_call';
  const bullish = forceBull || (!forceBear && biasScore >= 0);
  const spreadType = bullish ? 'Bull Put Credit' : 'Bear Call Credit';
  const biasLabel = Math.abs(biasScore) > 0.62 ? ('Strong ' + (bullish ? 'Bullish' : 'Bearish')) : (bullish ? 'Bullish' : 'Bearish');
  const monthlyDtes = cfg.monthly_chain_only ? monthlyDtesInRange(cfg.dte_min, cfg.dte_max) : null;
  if (cfg.monthly_chain_only && (!monthlyDtes || !monthlyDtes.length)) return null;
  const dte = cfg.monthly_chain_only
    ? monthlyDtes[Math.floor(seededUnit(seed, 5) * monthlyDtes.length)]
    : Math.round(cfg.dte_min + seededUnit(seed, 5) * Math.max(1, (cfg.dte_max - cfg.dte_min)));
  const widthChoices = price > 400 ? [5, 10, 15] : (price > 150 ? [2.5, 5, 10] : [1, 2.5, 5]);
  const width = widthChoices[Math.floor(seededUnit(seed, 6) * widthChoices.length)];
  // Minimum cushion needed to hit min_pop floor, plus seeded variation for spread diversity
  const minCushionPct = Math.max(0.05, (cfg.min_pop - 0.58 - 0.04) / 1.7);
  const cushion = Math.max(width * 1.5, price * (minCushionPct + seededUnit(seed, 7) * 0.10));
  const shortStrikeRaw = bullish ? price - cushion : price + cushion;
  const strikeStep = width >= 5 ? 5 : width;
  const shortStrike = Math.round(shortStrikeRaw / strikeStep) * strikeStep;
  const longStrike = bullish ? shortStrike - width : shortStrike + width;
  const ror = 0.08 + seededUnit(seed, 8) * 0.25;
  const maxRiskPerShare = width / (1 + ror);
  const creditPerShare = width - maxRiskPerShare;
  const credit = Math.round(creditPerShare * 100);
  const maxRisk = Math.round(maxRiskPerShare * 100);
  const ivRank = 0.16 + seededUnit(seed, 9) * 0.68;
  const ivPercentile = Math.min(0.97, ivRank + (seededUnit(seed, 10) - 0.5) * 0.18);
  const openInterest = Math.round(80 + seededUnit(seed, 11) * 4800);
  const bidAskPct = 0.05 + seededUnit(seed, 12) * 0.28;
  const earningsDays = Math.round(3 + seededUnit(seed, 13) * 65);
  const score = Math.max(0, Math.min(1,
    0.42 * Math.min(ror / 0.55, 1) +
    0.24 * Math.abs(biasScore) +
    0.22 * ivRank +
    0.12 * Math.min(openInterest / 2500, 1) -
    Math.max(0, bidAskPct - 0.18) * 0.6
  ));
  const breakeven = bullish ? shortStrike - creditPerShare : shortStrike + creditPerShare;
  const maxProfit = credit;
  const probabilityEstimate = Math.max(0.51, Math.min(0.88, 0.58 + cushion / price * 1.7 + seededUnit(seed, 14) * 0.08));

  return {
    ticker,
    price,
    bias_score: biasScore,
    bias_label: biasLabel,
    spread_type: spreadType,
    expiration: expirationFromDte(dte),
    dte,
    short_strike: shortStrike,
    long_strike: longStrike,
    width,
    credit,
    max_risk: maxRisk,
    max_profit: maxProfit,
    return_on_risk: credit / maxRisk,
    breakeven,
    iv_rank: ivRank,
    iv_percentile: ivPercentile,
    open_interest: openInterest,
    bid_ask_pct: bidAskPct,
    earnings_days: earningsDays,
    probability_estimate: probabilityEstimate,
    score,
    sector: ['Technology', 'Communication Services', 'Consumer Cyclical', 'Financial Services'][seed % 4],
    liquidity: bidAskPct <= 0.12 ? 'Excellent' : (bidAskPct <= 0.22 ? 'Good' : 'Fair'),
    monthly_chain: cfg.monthly_chain_only ? true : null,
    price_source: priceSource,
    price_timestamp: priceTimestamp || null,
    rank: index + 1
  };
}

async function fetchGlobalQuote(symbol) {
  const url = new URL(ALPHA_BASE_URL);
  url.searchParams.set('function', 'GLOBAL_QUOTE');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('apikey', API_KEY);

  const response = await fetch(url);
  if (!response.ok) {
    const details = await response.text();
    throw new Error('Alpha Vantage HTTP ' + response.status + ': ' + details.slice(0, 180));
  }

  const payload = await response.json();
  if (payload.Note) throw new Error(payload.Note);
  if (payload.Information) throw new Error(payload.Information);
  if (payload['Error Message']) throw new Error(payload['Error Message']);

  const quote = payload['Global Quote'] || {};
  const price = Number(quote['05. price'] || 0);
  return {
    symbol: quote['01. symbol'] || symbol,
    price,
    latestTradingDay: quote['07. latest trading day'] || null
  };
}

async function fetchLiveQuoteMap(symbols) {
  const map = new Map();
  if (!API_KEY || !symbols.length) return map;

  const pulls = await Promise.all(symbols.map(async (symbol) => {
    try {
      const quote = await fetchGlobalQuote(symbol);
      if (Number.isFinite(quote.price) && quote.price > 0) return [symbol, quote];
    } catch (_) {
      return null;
    }
    return null;
  }));

  pulls.forEach((entry) => {
    if (entry) map.set(entry[0], entry[1]);
  });
  return map;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  if (event.httpMethod === 'GET') {
    return j({ status: 'ok', mode: 'local', message: 'Render redirect removed. Scanner runs locally.' });
  }

  if (event.httpMethod !== 'POST') return j({ error: 'POST only' }, 405);

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return j({ error: 'Invalid JSON' }, 400); }

  const cfg = {
    tickers: parseTickers(body.tickers),
    strategy: body.strategy || 'auto',
    dte_min: Number(body.dte_min ?? 21),
    dte_max: Number(body.dte_max ?? 45),
    min_iv_rank: Number(body.min_iv_rank ?? 0.05),
    min_ror: Number(body.min_ror ?? 0.01),
    min_pop: Number(body.min_pop ?? 0.80),
    min_open_interest: Number(body.min_open_interest ?? 100),
    max_bid_ask_pct: Number(body.max_bid_ask_pct ?? 1.0),
    monthly_chain_only: body.monthly_chain_only === true,
    avoid_earnings: body.avoid_earnings !== false,
    require_directional: body.require_directional === true
  };

  if (!cfg.tickers.length) return j({ error: 'No tickers provided' }, 400);

  // Fetch live prices FIRST so strikes and probabilities are computed from real prices
  const quoteMap = await fetchLiveQuoteMap(cfg.tickers);
  let livePriceCount = 0;

  let results = cfg.tickers.map((ticker, i) => {
    const live = quoteMap.get(ticker);
    const livePrice = live ? Number(live.price.toFixed(2)) : null;
    if (live) livePriceCount++;
    return createCandidate(ticker, i, cfg, livePrice, live?.latestTradingDay || null);
  }).filter((row) => {
    if (!row) return false;
    if (row.iv_rank < cfg.min_iv_rank) return false;
    if (row.return_on_risk < cfg.min_ror) return false;
    if (row.probability_estimate < cfg.min_pop) return false;
    if (row.open_interest < cfg.min_open_interest) return false;
    if (row.bid_ask_pct > cfg.max_bid_ask_pct) return false;
    if (cfg.avoid_earnings && row.earnings_days <= 7) return false;
    if (cfg.require_directional && cfg.strategy === 'auto' && Math.abs(row.bias_score) < 0.08) return false;
    return true;
  });

  results = results.sort((a, b) => b.score - a.score).map((row, index) => ({ ...row, rank: index + 1 }));

  return j({
    mode: livePriceCount > 0 ? 'live' : 'local',
    results,
    quote_prices: {
      requested: cfg.tickers.length,
      live: livePriceCount,
      synthetic: cfg.tickers.length - livePriceCount
    }
  });
};
