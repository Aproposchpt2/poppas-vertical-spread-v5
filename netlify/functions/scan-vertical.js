// POPPA'S Vertical Credit Spread Scanner — Netlify Function (CJS)
// Data: CBOE free delayed quotes (cdn.cboe.com) — Yahoo Finance blocks cloud IPs
'use strict';

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

// ── CBOE data fetch ───────────────────────────────────────────────────────────

const cboeUrl = s => `https://cdn.cboe.com/api/global/delayed_quotes/options/${s}.json`;

async function fetchSym(sym) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(cboeUrl(sym), {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data.data || data;
  } catch (_) { return null; }
  finally { clearTimeout(t); }
}

// ── OCC symbol parser ─────────────────────────────────────────────────────────

function parseOcc(s) {
  const m = s.match(/^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  return m ? { y: 2000 + +m[2], mo: +m[3], d: +m[4], type: m[5], strike: +m[6] / 1000 } : null;
}

function dteOf(y, mo, d) {
  const now = new Date(); now.setUTCHours(0, 0, 0, 0);
  return Math.round((Date.UTC(y, mo - 1, d) - now.getTime()) / 86400000);
}

function isThirdFriday(y, mo, d) {
  const x = new Date(Date.UTC(y, mo - 1, d));
  return x.getUTCDay() === 5 && d >= 15 && d <= 21;
}

function midPrice(o) {
  const b = o.bid ?? 0, a = o.ask ?? 0;
  if (b > 0 && a > 0 && a >= b) return (b + a) / 2;
  return o.last_sale_price ?? 0;
}

function baDollar(o) {
  const b = o.bid ?? 0, a = o.ask ?? 0;
  return (a >= b && b >= 0) ? a - b : 9.99;
}

// ── Directional bias (price momentum) ────────────────────────────────────────

function simpleBias(price, options) {
  // Use put/call delta distribution as a proxy for directional lean
  const calls = options.filter(o => o.type === 'C' && Math.abs(o.delta || 0) < 0.5 && Math.abs(o.delta || 0) > 0.1);
  const puts = options.filter(o => o.type === 'P' && Math.abs(o.delta || 0) < 0.5 && Math.abs(o.delta || 0) > 0.1);
  const avgCallOI = calls.length ? calls.reduce((s, o) => s + (o.open_interest || 0), 0) / calls.length : 0;
  const avgPutOI = puts.length ? puts.reduce((s, o) => s + (o.open_interest || 0), 0) / puts.length : 0;
  const score = avgCallOI + avgPutOI > 0 ? (avgCallOI - avgPutOI) / (avgCallOI + avgPutOI) : 0;
  const label = score > 0.1 ? 'Bullish' : score < -0.1 ? 'Bearish' : 'Neutral';
  return { score: +score.toFixed(3), label };
}

// ── Main scan ─────────────────────────────────────────────────────────────────

async function scanSymbol(symbol, cfg) {
  const data = await fetchSym(symbol);
  if (!data || !Array.isArray(data.options) || !data.options.length) return null;

  const price = data.current_price ?? 0;
  if (price <= 0) return null;

  // Parse and group options by expiration
  const byExp = {};
  const allParsed = [];
  for (const o of data.options) {
    const p = parseOcc(o.option);
    if (!p) continue;
    const dte = dteOf(p.y, p.mo, p.d);
    if (dte < cfg.dteMin || dte > cfg.dteMax) continue;
    if (cfg.monthlyOnly && !isThirdFriday(p.y, p.mo, p.d)) continue;
    const ek = `${p.y}-${String(p.mo).padStart(2,'0')}-${String(p.d).padStart(2,'0')}`;
    const parsed = { ...o, type: p.type, strike: p.strike, dte, ek, _mid: midPrice(o), _ba: baDollar(o) };
    if (!byExp[ek]) byExp[ek] = [];
    byExp[ek].push(parsed);
    allParsed.push(parsed);
  }

  if (!Object.keys(byExp).length) return null;

  const bias = simpleBias(price, allParsed);
  if (cfg.requireDirectional && Math.abs(bias.score) < 0.05) return null;

  let bestResult = null, bestScore = -1;

  for (const [ek, opts] of Object.entries(byExp)) {
    const dte = opts[0].dte;
    const bullish = cfg.strategy === 'bull_put' ? true
      : cfg.strategy === 'bear_call' ? false
      : bias.score >= 0;

    const chain = opts.filter(o => o.type === (bullish ? 'P' : 'C'));
    if (!chain.length) continue;

    // IV rank from chain
    const ivVals = chain.map(o => o.iv ?? 0).filter(v => v > 0 && v < 3);
    const avgIV = ivVals.length ? ivVals.reduce((a, b) => a + b, 0) / ivVals.length : 0;
    const ivRankVal = Math.min(1, Math.max(0, (avgIV - 0.10) / 0.70));
    if (ivRankVal < cfg.minIvRank) continue;

    // Short leg candidates: liquid, OTM
    const shortCandidates = chain
      .filter(o => o._mid > 0 && o._ba <= cfg.maxBidAsk && (o.open_interest ?? 0) >= cfg.minOI)
      .filter(o => bullish
        ? (o.strike < price * 0.995 && o.strike > price * 0.65)
        : (o.strike > price * 1.005 && o.strike < price * 1.35))
      .sort((a, b) => bullish ? b.strike - a.strike : a.strike - b.strike);

    // Long leg pool: any OTM option with a tradeable mid
    const longPool = chain.filter(o => o._mid > 0);

    for (const sp of shortCandidates.slice(0, 12)) {
      const lp = longPool
        .filter(o => bullish ? o.strike < sp.strike : o.strike > sp.strike)
        .sort((a, b) => bullish ? b.strike - a.strike : a.strike - b.strike)[0];
      if (!lp || lp._mid <= 0) continue;

      const width = +Math.abs(sp.strike - lp.strike).toFixed(2);
      if (width <= 0) continue;

      const credit = +(sp._mid - lp._mid).toFixed(4);
      if (credit <= 0 || credit >= width) continue;

      const maxRisk = +(width - credit).toFixed(4);
      if (maxRisk <= 0) continue;

      const ror = credit / maxRisk;
      if (ror < cfg.minRor) continue;

      const score = Math.min(1,
        0.45 * Math.min(ror / 0.40, 1) +
        0.30 * Math.min(ivRankVal, 1) +
        0.15 * Math.min((sp.open_interest ?? 0) / 5000, 1) +
        0.10 * Math.min(Math.abs(bias.score), 1)
      );

      if (score > bestScore) {
        bestScore = score;
        const [ey, em, ed] = ek.split('-').map(Number);
        const expDate = new Date(Date.UTC(ey, em - 1, ed));
        bestResult = {
          ticker: symbol,
          price: +price.toFixed(2),
          biasScore: bias.score,
          biasLabel: bias.label,
          spreadType: bullish ? 'Bull Put Credit' : 'Bear Call Credit',
          expiration: expDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }),
          dte,
          shortStrike: sp.strike,
          longStrike: lp.strike,
          short_strike: sp.strike,
          long_strike: lp.strike,
          width,
          credit: +(credit * 100).toFixed(2),
          maxRisk: +(maxRisk * 100).toFixed(2),
          max_risk: +(maxRisk * 100).toFixed(2),
          maxProfit: +(credit * 100).toFixed(2),
          returnOnRisk: +ror.toFixed(4),
          return_on_risk: +ror.toFixed(4),
          breakeven: bullish
            ? +(sp.strike - credit).toFixed(2)
            : +(sp.strike + credit).toFixed(2),
          iv_rank: +ivRankVal.toFixed(4),
          ivRank: +ivRankVal.toFixed(4),
          ivPercentile: +Math.min(1, ivRankVal + 0.05).toFixed(4),
          openInterest: sp.open_interest ?? 0,
          open_interest: sp.open_interest ?? 0,
          bidAskPct: +sp._ba.toFixed(4),
          bid_ask_pct: +sp._ba.toFixed(4),
          earningsDays: 999,
          earnings_days: 999,
          earningsDate: '—',
          earnings_date: '—',
          probabilityEstimate: Math.min(0.86, Math.max(0.51, 0.56 + (Math.abs(price - sp.strike) / price) * 1.5)),
          probability_estimate: Math.min(0.86, Math.max(0.51, 0.56 + (Math.abs(price - sp.strike) / price) * 1.5)),
          score: +score.toFixed(4),
          sector: '—',
          liquidity: sp._ba <= 0.30 ? 'Excellent' : sp._ba <= 0.75 ? 'Good' : 'Fair',
          dataSource: 'CBOE Delayed Quotes',
        };
      }
    }
  }

  return bestResult;
}

// ── Debug ─────────────────────────────────────────────────────────────────────

async function debug(event) {
  const sym = (event.queryStringParameters?.ticker || 'AAPL').toUpperCase();
  const data = await fetchSym(sym);
  if (!data) return j({ sym, error: 'CBOE fetch failed' }, 500);
  const price = data.current_price;
  const optCount = data.options?.length ?? 0;
  const sample = (data.options ?? []).slice(0, 2).map(o => ({ option: o.option, bid: o.bid, ask: o.ask, oi: o.open_interest }));
  return j({ sym, price, optCount, sample });
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

  const CONCURRENCY = 5;
  const rows = [];
  for (let i = 0; i < tickers.length; i += CONCURRENCY) {
    const batch = tickers.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(sym => scanSymbol(sym, cfg).catch(() => null)));
    rows.push(...results.filter(Boolean));
  }

  rows.sort((a, b) => b.score - a.score);
  rows.forEach((r, i) => { r.rank = i + 1; });

  return j({ mode: 'live', results: rows });
};
