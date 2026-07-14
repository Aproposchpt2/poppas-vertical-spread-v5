// POPPA'S Vertical Spread Scan Server
// Deployed on Render — Yahoo Finance not blocked here
'use strict';

const http = require('http');
const _yfMod = require('yahoo-finance2');
const yf = typeof _yfMod?.quoteSummary === 'function' ? _yfMod
         : typeof _yfMod?.default?.quoteSummary === 'function' ? _yfMod.default
         : _yfMod;

const PORT = process.env.PORT || 3000;

// ── Math helpers ──────────────────────────────────────────────────────────────

function normCDF(x) {
  const a = [0.319381530, -0.356563782, 1.781477937, -1.821255978, 1.330274429];
  const k = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly = k * (a[0] + k * (a[1] + k * (a[2] + k * (a[3] + k * a[4]))));
  const pdf = Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
  const val = 1 - pdf * poly;
  return x >= 0 ? val : 1 - val;
}

function mid(opt) {
  const b = opt.bid ?? 0, a = opt.ask ?? 0, l = opt.lastPrice ?? 0;
  if (b > 0 && a > 0 && a >= b) return (b + a) / 2;
  return l > 0 ? l : 0;
}

function baDollar(opt) {
  const b = opt.bid ?? 0, a = opt.ask ?? 0;
  return (a >= b && b >= 0) ? a - b : 9.99;
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
  const vals = chain.map(o => o.impliedVolatility ?? 0).filter(v => v > 0 && v < 3);
  if (!vals.length) return 0;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return Math.min(1, Math.max(0, (mean - 0.15) / 0.70));
}

// ── Spread selection ──────────────────────────────────────────────────────────

function selectSpread(chain, price, bullish, cfg) {
  const shortCandidates = chain
    .map(o => ({ ...o, _mid: mid(o), _ba: baDollar(o) }))
    .filter(o => o._mid > 0 && o._ba <= cfg.maxBidAsk && (o.openInterest ?? 0) >= cfg.minOI)
    .filter(o => bullish
      ? (o.strike < price * 0.995 && o.strike > price * 0.70)
      : (o.strike > price * 1.005 && o.strike < price * 1.30))
    .sort((a, b) => bullish ? b.strike - a.strike : a.strike - b.strike);

  const longPool = chain
    .map(o => ({ ...o, _mid: mid(o) }))
    .filter(o => o._mid > 0);

  let best = null, bestQuality = -1;

  for (const sp of shortCandidates.slice(0, 15)) {
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
      const q = ror - sp._ba * 0.1 + Math.min((sp.openInterest ?? 0) / 10000, 0.2);
      if (best === null || q > bestQuality) {
        bestQuality = q;
        best = {
          shortStrike: sp.strike, longStrike: lp.strike, short_strike: sp.strike, long_strike: lp.strike,
          width, credit: +(credit * 100).toFixed(2), maxRisk: +(maxRisk * 100).toFixed(2),
          max_risk: +(maxRisk * 100).toFixed(2), max_profit: +(credit * 100).toFixed(2),
          returnOnRisk: +ror.toFixed(4), return_on_risk: +ror.toFixed(4),
          openInterest: Math.min(sp.openInterest ?? 0, lp.openInterest ?? 0),
          open_interest: Math.min(sp.openInterest ?? 0, lp.openInterest ?? 0),
          bidAskPct: +sp._ba.toFixed(4), bid_ask_pct: +sp._ba.toFixed(4),
          iv: ((sp.impliedVolatility ?? 0) + (lp.impliedVolatility ?? 0)) / 2,
        };
      }
    }
  }
  return best;
}

// ── Main scan ─────────────────────────────────────────────────────────────────

async function scanSymbol(symbol, cfg) {
  const ticker = await yf.quoteSummary(symbol, {
    modules: ['price', 'calendarEvents'],
  }).catch(() => null);
  if (!ticker) return null;

  const price = ticker.price?.regularMarketPrice ?? 0;
  if (price <= 0) return null;

  const earningsRaw = ticker.calendarEvents?.earnings?.earningsDate?.[0] ?? null;
  const earningsDays = earningsRaw
    ? Math.round((new Date(earningsRaw) - Date.now()) / 86400000)
    : 999;
  if (cfg.avoidEarnings && earningsDays >= 0 && earningsDays <= 7) return null;
  const earningsDate = earningsRaw
    ? String(new Date(earningsRaw).getMonth() + 1).padStart(2, '0') + '/' + String(new Date(earningsRaw).getDate()).padStart(2, '0')
    : '—';

  const hist = await yf.chart(symbol, {
    period1: new Date(Date.now() - 365 * 86400000).toISOString().split('T')[0],
    interval: '1d',
  }).catch(() => null);
  const closes = hist?.quotes?.map(q => q.close).filter(Boolean) ?? [];
  const bias = calcBias(closes);

  if (cfg.requireDirectional && Math.abs(bias.score) < 0.08) return null;
  const bullish = cfg.strategy === 'bull_put' ? true
    : cfg.strategy === 'bear_call' ? false
    : bias.score > 0;

  const expirations = await yf.options(symbol).then(r => r.expirationDates ?? []).catch(() => []);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const validExps = expirations.filter(d => {
    const dte = Math.round((new Date(d) - today) / 86400000);
    if (dte < cfg.dteMin || dte > cfg.dteMax) return false;
    if (cfg.monthlyOnly) {
      const ed = new Date(d);
      return ed.getUTCDay() === 5 && ed.getUTCDate() >= 15 && ed.getUTCDate() <= 21;
    }
    return true;
  });
  if (!validExps.length) return null;

  let bestResult = null, bestScore = -1;

  for (const expDate of validExps.slice(0, 4)) {
    const dte = Math.round((new Date(expDate) - today) / 86400000);
    const optData = await yf.options(symbol, { date: expDate }).catch(() => null);
    if (!optData) continue;

    const chain = bullish ? optData.puts : optData.calls;
    if (!chain?.length) continue;

    const ivr = ivRank(chain);
    if (ivr < cfg.minIvRank) continue;

    const spread = selectSpread(chain, price, bullish, cfg);
    if (!spread) continue;

    const ror = spread.returnOnRisk;
    const cushion = Math.abs(price - spread.shortStrike) / Math.max(price, 1);
    const probability = Math.min(0.86, Math.max(0.51, 0.56 + cushion * 1.7));
    const score = Math.min(1, Math.max(0,
      0.42 * Math.min(ror / 0.55, 1) +
      0.24 * Math.abs(bias.score) +
      0.22 * ivr +
      0.12 * Math.min(spread.openInterest / 2500, 1) -
      Math.max(0, spread.bidAskPct - 0.18) * 0.6
    ));

    if (score > bestScore) {
      bestScore = score;
      const credit = spread.credit / 100;
      bestResult = {
        ticker: symbol, price: +price.toFixed(2),
        biasScore: bias.score, bias_score: bias.score,
        biasLabel: bias.label, bias_label: bias.label,
        spreadType: bullish ? 'Bull Put Credit' : 'Bear Call Credit',
        spread_type: bullish ? 'Bull Put Credit' : 'Bear Call Credit',
        expiration: new Date(expDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        dte, ...spread,
        breakeven: bullish ? +(spread.shortStrike - credit).toFixed(2) : +(spread.shortStrike + credit).toFixed(2),
        ivRank: +ivr.toFixed(4), iv_rank: +ivr.toFixed(4),
        ivPercentile: Math.min(1, ivr + 0.08),
        earningsDays: earningsDays < 999 ? earningsDays : 999,
        earnings_days: earningsDays < 999 ? earningsDays : 999,
        earningsDate, earnings_date: earningsDate,
        probabilityEstimate: +probability.toFixed(4),
        probability_estimate: +probability.toFixed(4),
        score: +score.toFixed(4),
        sector: '—',
        liquidity: spread.bidAskPct <= 0.12 ? 'Excellent' : spread.bidAskPct <= 0.22 ? 'Good' : 'Fair',
      };
    }
  }
  return bestResult;
}

// ── HTTP Server ───────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const server = http.createServer(async (req, res) => {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/health') {
    const log = [];
    try {
      const q = await yf.quoteSummary('AAPL', { modules: ['price'] }).catch(e => { log.push('quoteSummary err: ' + e.message.slice(0,100)); return null; });
      log.push('price: ' + (q?.price?.regularMarketPrice ?? 'null'));
    } catch(e) { log.push('fatal: ' + e.message); }
    res.writeHead(200); res.end(JSON.stringify({ status: 'ok', yf: log })); return;
  }

  if (req.method === 'GET' && req.url.startsWith('/debug')) {
    const sym = req.url.split('?')[1]?.split('=')[1] || 'AAPL';
    const log = [];
    try {
      const q = await yf.quoteSummary(sym, { modules: ['price'] }).catch(e => { log.push('quoteSummary error: ' + e.message.slice(0, 120)); return null; });
      log.push('quoteSummary price: ' + (q?.price?.regularMarketPrice ?? 'null'));
      const c = await yf.chart(sym, { period1: new Date(Date.now() - 2*86400000).toISOString().split('T')[0], interval: '1d' }).catch(e => { log.push('chart error: ' + e.message.slice(0, 120)); return null; });
      log.push('chart price: ' + (c?.meta?.regularMarketPrice ?? 'null'));
      const o = await yf.options(sym).catch(e => { log.push('options error: ' + e.message.slice(0, 120)); return null; });
      log.push('options expirations: ' + (o?.expirationDates?.length ?? 'null'));
    } catch(e) { log.push('fatal: ' + e.message); }
    res.writeHead(200); res.end(JSON.stringify({ sym, log })); return;
  }

  if (req.method !== 'POST' || req.url !== '/api/scan/spread') {
    res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return;
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    try {
      const input = JSON.parse(body || '{}');
      const tickers = (input.tickers || []).map(t => String(t).toUpperCase().trim()).filter(Boolean).slice(0, 25);
      if (!tickers.length) { res.writeHead(400); res.end(JSON.stringify({ error: 'tickers required' })); return; }

      const cfg = {
        strategy: input.strategy || 'auto',
        dteMin: Math.max(1, input.dte_min ?? 21),
        dteMax: Math.min(365, input.dte_max ?? 45),
        minIvRank: input.min_iv_rank ?? 0.05,
        minRor: input.min_ror ?? 0.05,
        minOI: input.min_open_interest ?? 100,
        maxBidAsk: input.max_bid_ask_pct ?? 1.00,
        monthlyOnly: input.monthly_chain_only === true,
        requireDirectional: input.require_directional === true,
        avoidEarnings: input.avoid_earnings !== false,
      };

      const CONCURRENCY = 3;
      const rows = [];
      for (let i = 0; i < tickers.length; i += CONCURRENCY) {
        const batch = tickers.slice(i, i + CONCURRENCY);
        const results = await Promise.all(batch.map(sym => scanSymbol(sym, cfg).catch(() => null)));
        rows.push(...results.filter(Boolean));
      }
      rows.sort((a, b) => b.score - a.score);
      rows.forEach((r, i) => { r.rank = i + 1; });

      res.writeHead(200); res.end(JSON.stringify({ mode: 'live', results: rows }));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
  });
});

server.listen(PORT, () => console.log(`Vertical spread scan server on port ${PORT}`));
