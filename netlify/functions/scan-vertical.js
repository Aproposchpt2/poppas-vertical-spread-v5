// POPPA'S Vertical Credit Spread Scanner — Netlify Function (CJS)
'use strict';
const _yfMod = require('yahoo-finance2');
const yahooFinance = typeof _yfMod?.quoteSummary === 'function' ? _yfMod
    : typeof _yfMod?.default?.quoteSummary === 'function' ? _yfMod.default
    : _yfMod;

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const j = (body, status = 200) => ({
  statusCode: status,
  headers: CORS,
  body: JSON.stringify(body),
});

// ── Math helpers ─────────────────────────────────────────────────────────────

function normCDF(x) {
  const a = [0.319381530, -0.356563782, 1.781477937, -1.821255978, 1.330274429];
  const k = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly = k * (a[0] + k * (a[1] + k * (a[2] + k * (a[3] + k * a[4]))));
  const pdf = Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
  const val = 1 - pdf * poly;
  return x >= 0 ? val : 1 - val;
}

function bsPrice(S, K, T, iv, isPut) {
  if (T <= 0 || iv <= 0 || S <= 0 || K <= 0) return 0;
  const r = 0.045;
  const d1 = (Math.log(S / K) + (r + iv * iv / 2) * T) / (iv * Math.sqrt(T));
  const d2 = d1 - iv * Math.sqrt(T);
  return isPut
    ? Math.max(0, K * Math.exp(-r * T) * normCDF(-d2) - S * normCDF(-d1))
    : Math.max(0, S * normCDF(d1) - K * Math.exp(-r * T) * normCDF(d2));
}

function mid(opt) {
  const b = opt.bid ?? 0, a = opt.ask ?? 0, l = opt.lastPrice ?? 0;
  if (b > 0 && a > 0 && a >= b) return (b + a) / 2;
  return l > 0 ? l : 0;
}

function baDollar(opt) {
  const b = opt.bid ?? 0, a = opt.ask ?? 0;
  if (a >= b && b >= 0) return a - b;
  return 9.99;
}

// ── Directional bias ──────────────────────────────────────────────────────────

function calcBias(closes) {
  if (!closes || closes.length < 55) return { score: 0, label: 'Neutral' };
  const price = closes[closes.length - 1];
  const ema = (arr, span) => {
    const k = 2 / (span + 1);
    return arr.reduce((acc, v, i) => {
      acc.push(i === 0 ? v : v * k + acc[acc.length - 1] * (1 - k));
      return acc;
    }, []);
  };
  const ma20 = ema(closes, 20); const ma50 = ema(closes, 50);
  const roc21 = (price / closes[closes.length - 22] - 1);
  const macd = ema(closes, 12).map((v, i) => v - ema(closes, 26)[i]);
  const sig = ema(macd, 9);
  const hist = macd.map((v, i) => v - sig[i]);
  const macdSlope = (hist[hist.length - 1] - hist[hist.length - 2]) / Math.max(price, 1);
  let score = ma20[ma20.length - 1] > ma50[ma50.length - 1] ? 0.25 : -0.25;
  score += Math.max(-0.20, Math.min(0.20, roc21));
  score += Math.max(-0.10, Math.min(0.10, macdSlope * 10));
  score = Math.max(-1, Math.min(1, score));
  const label = score >= 0.5 ? 'Strong Bullish' : score >= 0.1 ? 'Bullish'
    : score <= -0.5 ? 'Strong Bearish' : score <= -0.1 ? 'Bearish' : 'Neutral';
  return { score: Math.round(score * 1000) / 1000, label };
}

// ── IV Rank ───────────────────────────────────────────────────────────────────

function ivRank(chain) {
  const vals = chain
    .map(o => o.impliedVolatility ?? 0)
    .filter(v => v > 0 && v < 3);
  if (!vals.length) return 0;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return Math.min(1, Math.max(0, (mean - 0.15) / 0.70));
}

// ── Spread selection ──────────────────────────────────────────────────────────

function selectSpread(chain, price, bullish, cfg) {
  // Short legs need OI and bid-ask filters; long (wing) legs just need a tradeable mid
  const shorts = chain
    .map(o => ({ ...o, _mid: mid(o), _ba: baDollar(o) }))
    .filter(o => o._mid > 0 && o._ba <= cfg.maxBidAsk && (o.openInterest ?? 0) >= cfg.minOI
      && (bullish ? (o.strike < price * 0.99 && o.strike > price * 0.70) : (o.strike > price * 1.01 && o.strike < price * 1.30)))
    .sort((a, b) => bullish ? b.strike - a.strike : a.strike - b.strike);

  const longPool = chain
    .map(o => ({ ...o, _mid: mid(o) }))
    .filter(o => o._mid > 0);

  let best = null, bestQuality = -1;

  for (const sp of shorts.slice(0, 15)) {
    const longOpts = longPool
      .filter(o => bullish ? o.strike < sp.strike : o.strike > sp.strike)
      .sort((a, b) => bullish ? b.strike - a.strike : a.strike - b.strike);

    for (const lp of longOpts.slice(0, 8)) {
      const width = Math.abs(sp.strike - lp.strike);
      if (width <= 0) continue;
      const credit = sp._mid - lp._mid;
      if (credit <= 0 || credit >= width) continue;
      const maxRisk = width - credit;
      const ror = credit / maxRisk;
      if (ror < cfg.minRor) continue;
      const q = ror - sp._ba * 0.35 + Math.min((sp.openInterest ?? 0) / 10000, 0.2);
      if (best === null || q > bestQuality) {
        bestQuality = q;
        best = {
          shortStrike: sp.strike, longStrike: lp.strike,
          width, credit: +(credit * 100).toFixed(2),
          maxRisk: +(maxRisk * 100).toFixed(2), ror,
          openInterest: Math.min(sp.openInterest ?? 0, lp.openInterest ?? 0),
          bidAskPct: Math.max(sp._ba, lp._ba),
          iv: ((sp.impliedVolatility ?? 0) + (lp.impliedVolatility ?? 0)) / 2,
        };
      }
    }
  }
  return best;
}

// ── Main scan ─────────────────────────────────────────────────────────────────

async function scanSymbol(symbol, cfg) {
  const ticker = await yahooFinance.quoteSummary(symbol, {
    modules: ['price', 'calendarEvents'],
  }).catch(() => null);
  if (!ticker) return null;

  const price = ticker.price?.regularMarketPrice ?? 0;
  if (price <= 0) return null;

  // Earnings check
  const earningsRaw = ticker.calendarEvents?.earnings?.earningsDate?.[0] ?? null;
  const earningsDays = earningsRaw
    ? Math.round((new Date(earningsRaw) - Date.now()) / 86400000)
    : 999;
  if (cfg.avoidEarnings && earningsDays <= 7) return null;
  const earningsDate = earningsRaw
    ? String(new Date(earningsRaw).getMonth() + 1).padStart(2, "0") + "/" + String(new Date(earningsRaw).getDate()).padStart(2, "0")
    : "—";

  // Historical prices for bias
  const hist = await yahooFinance.chart(symbol, {
    period1: new Date(Date.now() - 365 * 86400000).toISOString().split('T')[0],
    interval: '1d',
  }).catch(() => null);
  const closes = hist?.quotes?.map(q => q.close).filter(Boolean) ?? [];
  const bias = calcBias(closes);

  if (cfg.strategy === 'auto' && cfg.requireDirectional && Math.abs(bias.score) < 0.08) return null;
  const bullish = cfg.strategy === 'bull_put' ? true
    : cfg.strategy === 'bear_call' ? false
    : bias.score > 0;

  // Option expirations
  const expirations = await yahooFinance.options(symbol).then(r => r.expirationDates ?? []).catch(() => []);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const validExps = expirations.filter(d => {
    const dte = Math.round((new Date(d) - today) / 86400000);
    if (dte < cfg.dteMin || dte > cfg.dteMax) return false;
    if (cfg.monthlyOnly) {
      const expDate = new Date(d);
      const day = expDate.getUTCDay(), date = expDate.getUTCDate();
      return day === 5 && date >= 15 && date <= 21;
    }
    return true;
  });

  let bestResult = null, bestScore = -1;

  for (const expDate of validExps.slice(0, 4)) {
    const dte = Math.round((new Date(expDate) - today) / 86400000);
    const optData = await yahooFinance.options(symbol, { date: expDate }).catch(() => null);
    if (!optData) continue;

    const chain = bullish ? optData.puts : optData.calls;
    if (!chain?.length) continue;

    const ivr = ivRank(chain);
    if (ivr < cfg.minIvRank) continue;

    const spread = selectSpread(chain, price, bullish, cfg);
    if (!spread) continue;

    const ror = spread.ror;
    const score = Math.min(1, Math.max(0,
      0.42 * Math.min(ror / 0.55, 1)
      + 0.24 * Math.abs(bias.score)
      + 0.22 * ivr
      + 0.12 * Math.min(spread.openInterest / 2500, 1)
      - Math.max(0, spread.bidAskPct - 0.18) * 0.6
    ));

    const shortStrike = spread.shortStrike;
    const credit = spread.credit / 100;
    const breakeven = bullish ? +(shortStrike - credit).toFixed(2) : +(shortStrike + credit).toFixed(2);
    const cushion = Math.abs(price - shortStrike) / Math.max(price, 1);
    const probability = Math.min(0.86, Math.max(0.51, 0.56 + cushion * 1.7));

    if (score > bestScore) {
      bestScore = score;
      bestResult = {
        ticker: symbol, price: +price.toFixed(2),
        biasScore: bias.score, biasLabel: bias.label,
        spreadType: bullish ? 'Bull Put Credit' : 'Bear Call Credit',
        expiration: new Date(expDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        dte, shortStrike: spread.shortStrike, longStrike: spread.longStrike,
        width: spread.width, credit: spread.credit, maxRisk: spread.maxRisk,
        maxProfit: spread.credit, returnOnRisk: +ror.toFixed(4),
        breakeven, ivRank: +ivr.toFixed(4), ivPercentile: Math.min(1, ivr + 0.08),
        openInterest: spread.openInterest, bidAskPct: +spread.bidAskPct.toFixed(4),
        earningsDays: earningsDays < 999 ? earningsDays : 999,
        earningsDate,
        probabilityEstimate: +probability.toFixed(4), score: +score.toFixed(4),
        liquidity: spread.bidAskPct <= 0.12 ? 'Excellent' : spread.bidAskPct <= 0.22 ? 'Good' : 'Fair',
      };
    }
  }
  return bestResult;
}

// ── Debug Handler ─────────────────────────────────────────────────────────────

async function debug(event) {
  const sym = (event.queryStringParameters?.ticker || 'AAPL').toUpperCase();
  const log = [];
  try {
    // Step 1: price
    const ticker = await yahooFinance.quoteSummary(sym, { modules: ['price', 'calendarEvents'] }).catch(e => { log.push('quoteSummary error: ' + e.message); return null; });
    if (!ticker) return j({ sym, log, step: 'quoteSummary failed' });
    const price = ticker.price?.regularMarketPrice ?? 0;
    log.push('price: ' + price);
    if (price <= 0) return j({ sym, log, step: 'price <= 0' });

    // Step 2: expirations
    const expirations = await yahooFinance.options(sym).then(r => r.expirationDates ?? []).catch(e => { log.push('options error: ' + e.message); return []; });
    log.push('expirations: ' + expirations.slice(0, 6).join(', '));
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const validExps = expirations.filter(d => {
      const dte = Math.round((new Date(d) - today) / 86400000);
      return dte >= 21 && dte <= 45;
    });
    log.push('valid exps (21-45 DTE): ' + validExps.join(', '));
    if (!validExps.length) return j({ sym, log, step: 'no valid expirations in 21-45 DTE' });

    // Step 3: option chain for first valid exp
    const expDate = validExps[0];
    const dte = Math.round((new Date(expDate) - today) / 86400000);
    const optData = await yahooFinance.options(sym, { date: expDate }).catch(e => { log.push('options chain error: ' + e.message); return null; });
    if (!optData) return j({ sym, log, step: 'option chain fetch failed' });
    const puts = optData.puts ?? [];
    const calls = optData.calls ?? [];
    log.push('puts: ' + puts.length + ', calls: ' + calls.length);
    log.push('sample put: ' + JSON.stringify(puts[0] ? { strike: puts[0].strike, bid: puts[0].bid, ask: puts[0].ask, oi: puts[0].openInterest } : null));

    return j({ sym, price, expDate, dte, validExps, log });
  } catch(e) { return j({ error: e.message, sym, log }, 500); }
}

// ── Handler ───────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod === 'GET') return debug(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return j({ error: 'POST only' }, 405);

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return j({ error: 'Invalid JSON' }, 400); }

  const tickers = (body.tickers || []).map(t => String(t).toUpperCase().trim()).filter(Boolean).slice(0, 25);
  if (!tickers.length) return j({ error: 'At least one ticker required' }, 400);

  const cfg = {
    strategy: body.strategy || 'auto',
    dteMin: Math.max(1, body.dte_min ?? 21),
    dteMax: Math.min(365, body.dte_max ?? 45),
    minIvRank: body.min_iv_rank ?? 0.05,
    minRor: body.min_ror ?? 0.05,
    minOI: body.min_open_interest ?? 100,
    maxBidAsk: body.max_bid_ask_pct ?? 1.00,
    monthlyOnly: body.monthly_chain_only === true,
    requireDirectional: body.require_directional === true,
    avoidEarnings: body.avoid_earnings !== false,
  };

  const CONCURRENCY = 3;
  const rows = [];
  for (let i = 0; i < tickers.length; i += CONCURRENCY) {
    const batch = tickers.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(sym => scanSymbol(sym, cfg).catch(() => null))
    );
    rows.push(...batchResults.filter(Boolean));
  }

  rows.sort((a, b) => b.score - a.score);
  rows.forEach((r, i) => { r.rank = i + 1; });

  return j({ mode: 'live', results: rows });
};
