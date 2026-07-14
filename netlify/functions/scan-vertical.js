// POPPA'S Vertical Credit Spread Scanner — Netlify Function
// Proxies to poppas-vertical-spread-screener.onrender.com/api/scan
// Render has unrestricted Yahoo Finance access; Netlify IPs are blocked.
'use strict';

const RENDER_API = 'https://poppas-vertical-spread-screener.onrender.com/api/scan';

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const j = (body, status = 200) => ({
  statusCode: status,
  headers: CORS,
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  // Debug: test Render reachability
  if (event.httpMethod === 'GET') {
    try {
      const ping = await fetch(RENDER_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tickers: ['AAPL'], strategy: 'auto', dte_min: 21, dte_max: 45, min_iv_rank: 0.0, min_ror: 0.05, min_open_interest: 100, max_bid_ask_pct: 1.0, avoid_earnings: false }),
      });
      const data = await ping.json();
      return j({ status: 'render_ok', mode: data.mode, count: data.results?.length ?? 0, sample: data.results?.[0]?.ticker ?? null });
    } catch (e) {
      return j({ status: 'render_error', error: e.message }, 500);
    }
  }

  if (event.httpMethod !== 'POST') return j({ error: 'POST only' }, 405);

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return j({ error: 'Invalid JSON' }, 400); }

  // Map frontend params to Render API format
  const renderBody = {
    tickers: (body.tickers || []).slice(0, 25),
    strategy: body.strategy || 'auto',
    dte_min: body.dte_min ?? 21,
    dte_max: body.dte_max ?? 45,
    min_iv_rank: body.min_iv_rank ?? 0.05,
    min_ror: body.min_ror ?? 0.05,
    min_open_interest: body.min_open_interest ?? 100,
    // Render uses percentage (0-2), not dollars — clamp to valid range
    max_bid_ask_pct: Math.min(2.0, Math.max(0, body.max_bid_ask_pct ?? 1.0)),
    avoid_earnings: body.avoid_earnings !== false,
  };

  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 55000);
    const res = await fetch(RENDER_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(renderBody),
      signal: ctrl.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const errText = await res.text();
      return j({ error: 'Render API error', detail: errText.slice(0, 200) }, 502);
    }

    const data = await res.json();
    return j({ mode: 'live', results: data.results ?? [] });
  } catch (e) {
    return j({ error: e.message }, 502);
  }
};
