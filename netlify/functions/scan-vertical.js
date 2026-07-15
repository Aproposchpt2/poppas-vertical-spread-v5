'use strict';
// POPPA'S PRO — Vertical Credit Spread Scanner
// Data source: Supabase scan_candidates table
// Populated by poppasv2.ai4academy.net via Schwab live options chain
// Real Prob OTM · real OI · real bid/ask · real credit from Schwab

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const j = (body, status = 200) => ({ statusCode: status, headers: CORS, body: JSON.stringify(body) });

function sbHeaders() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };
}

function parseTickers(input) {
  if (!input) return [];
  const arr = Array.isArray(input) ? input : String(input).split(/[\s,;]+/);
  return [...new Set(arr.map(v => String(v || '').toUpperCase().trim()).filter(Boolean))].slice(0, 100);
}

// ── Supabase helpers ──────────────────────────────────────────────────────────

async function sbGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbHeaders() });
  if (!res.ok) throw new Error(`Supabase ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Get latest completed scan run
async function latestRun() {
  const rows = await sbGet('scan_runs?select=id,started_at,completed_at,status,strategy&status=eq.completed&order=completed_at.desc&limit=1');
  if (Array.isArray(rows) && rows[0]) return rows[0];
  // Fallback: any run
  const any = await sbGet('scan_runs?select=id,started_at,completed_at,status,strategy&order=started_at.desc&limit=1');
  return Array.isArray(any) ? any[0] : null;
}

// ── Map Supabase condor row → vertical spread candidate ───────────────────────
// Each iron condor has a put side (Bull Put Credit) and call side (Bear Call Credit).
// We split into two vertical spread candidates so the table shows both opportunities.

function mapPutSpread(r, idx) {
  if (!r.short_put || !r.long_put) return null;
  const credit    = +(r.credit ?? r.mid_credit ?? 0);
  const width     = +(r.width ?? Math.abs(r.short_put - r.long_put));
  const maxRisk   = +(r.max_risk ?? (width - credit));
  const ror       = maxRisk > 0 ? credit / maxRisk : 0;
  const probOtm   = +(r.prob_otm ?? r.put_prob_otm ?? 0);
  const iv        = +(r.iv ?? 0) > 1 ? +(r.iv) / 100 : +(r.iv ?? 0);
  const oi        = +(r.short_put_oi ?? r.open_interest ?? 0);
  const spreadMax = +(r.spread_max ?? 0);

  return {
    ticker:               r.symbol,
    price:                +(r.spot ?? 0),
    bias_score:           0.6,
    bias_label:           'Bullish',
    spread_type:          'Bull Put Credit',
    expiration:           r.expiry ? new Date(r.expiry + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—',
    dte:                  +(r.dte ?? 0),
    short_strike:         +(r.short_put),
    long_strike:          +(r.long_put),
    width:                +width.toFixed(2),
    credit:               Math.round(credit * 100),
    max_risk:             Math.round(maxRisk * 100),
    max_profit:           Math.round(credit * 100),
    return_on_risk:       +ror.toFixed(4),
    breakeven:            +(r.short_put - credit).toFixed(2),
    iv_rank:              +iv.toFixed(4),
    iv_percentile:        +iv.toFixed(4),
    open_interest:        oi,
    bid_ask_pct:          +spreadMax.toFixed(4),
    earnings_days:        r.earnings ? 0 : 999,
    earnings_date:        r.earnings_date || '—',
    probability_estimate: +probOtm.toFixed(4),
    score:                +(r.score ?? 0),
    sector:               r.sector || '—',
    liquidity:            spreadMax <= 0.05 ? 'Excellent' : spreadMax <= 0.15 ? 'Good' : 'Fair',
    passed:               !!r.passed,
    price_source:         'schwab',
    rank:                 idx + 1,
  };
}

function mapCallSpread(r, idx) {
  if (!r.short_call || !r.long_call) return null;
  const credit    = +(r.credit ?? r.mid_credit ?? 0);
  const width     = +(r.width ?? Math.abs(r.long_call - r.short_call));
  const maxRisk   = +(r.max_risk ?? (width - credit));
  const ror       = maxRisk > 0 ? credit / maxRisk : 0;
  const probOtm   = +(r.prob_otm ?? r.call_prob_otm ?? 0);
  const iv        = +(r.iv ?? 0) > 1 ? +(r.iv) / 100 : +(r.iv ?? 0);
  const oi        = +(r.short_call_oi ?? r.open_interest ?? 0);
  const spreadMax = +(r.spread_max ?? 0);

  return {
    ticker:               r.symbol,
    price:                +(r.spot ?? 0),
    bias_score:           -0.6,
    bias_label:           'Bearish',
    spread_type:          'Bear Call Credit',
    expiration:           r.expiry ? new Date(r.expiry + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—',
    dte:                  +(r.dte ?? 0),
    short_strike:         +(r.short_call),
    long_strike:          +(r.long_call),
    width:                +width.toFixed(2),
    credit:               Math.round(credit * 100),
    max_risk:             Math.round(maxRisk * 100),
    max_profit:           Math.round(credit * 100),
    return_on_risk:       +ror.toFixed(4),
    breakeven:            +(r.short_call + credit).toFixed(2),
    iv_rank:              +iv.toFixed(4),
    iv_percentile:        +iv.toFixed(4),
    open_interest:        oi,
    bid_ask_pct:          +spreadMax.toFixed(4),
    earnings_days:        r.earnings ? 0 : 999,
    earnings_date:        r.earnings_date || '—',
    probability_estimate: +probOtm.toFixed(4),
    score:                +(r.score ?? 0),
    sector:               r.sector || '—',
    liquidity:            spreadMax <= 0.05 ? 'Excellent' : spreadMax <= 0.15 ? 'Good' : 'Fair',
    passed:               !!r.passed,
    price_source:         'schwab',
    rank:                 idx + 1,
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod === 'GET')     return j({ status: 'ok', source: 'supabase/schwab', ready: !!(SUPABASE_URL && SUPABASE_KEY) });
  if (event.httpMethod !== 'POST')    return j({ error: 'POST only' }, 405);

  if (!SUPABASE_URL || !SUPABASE_KEY) return j({
    error: 'Supabase not configured',
    hint: 'Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to Netlify environment variables'
  }, 500);

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return j({ error: 'Invalid JSON' }, 400); }

  const tickers = parseTickers(body.tickers);
  const strategy = body.strategy || 'auto';

  // Get latest scan run
  let run;
  try { run = await latestRun(); }
  catch (e) { return j({ error: 'Could not fetch scan run: ' + e.message }, 502); }

  if (!run) return j({ error: 'No scan data available yet. The Schwab scan may still be running.' }, 503);

  // Build query for scan_candidates
  let params = [
    'select=*',
    `scan_run_id=eq.${encodeURIComponent(run.id)}`,
    'order=score.desc,roc.desc',
    'limit=500',
  ];

  // Filter to requested tickers if provided
  if (tickers.length) {
    params.push(`symbol=in.(${tickers.map(t => encodeURIComponent(t)).join(',')})`);
  }

  let rows;
  try {
    rows = await sbGet(`scan_candidates?${params.join('&')}`);
  } catch (e) {
    return j({ error: 'Could not fetch candidates: ' + e.message }, 502);
  }

  if (!Array.isArray(rows)) return j({ error: 'Unexpected response from Supabase' }, 502);

  // Split each condor into put and call vertical spreads
  const candidates = [];
  for (const r of rows) {
    if (strategy === 'auto' || strategy === 'bull_put') {
      const put = mapPutSpread(r, 0);
      if (put) candidates.push(put);
    }
    if (strategy === 'auto' || strategy === 'bear_call') {
      const call = mapCallSpread(r, 0);
      if (call) candidates.push(call);
    }
  }

  // Re-rank by score
  candidates.sort((a, b) => b.score - a.score);
  candidates.forEach((c, i) => { c.rank = i + 1; });

  return j({
    mode:   'live',
    source: 'supabase/schwab',
    scan_run: {
      id:           run.id,
      completed_at: run.completed_at,
      strategy:     run.strategy,
    },
    results: candidates,
    meta: {
      condors_in_run:   rows.length,
      spreads_returned: candidates.length,
    }
  });
};
