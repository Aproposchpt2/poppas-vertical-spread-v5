'use strict';

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (body, statusCode = 200) => ({
  statusCode,
  headers: CORS,
  body: JSON.stringify(body),
});

function headers() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function get(path) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: headers() });
  if (!response.ok) throw new Error(`Supabase request failed (${response.status})`);
  return response.json();
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') return json({ error: 'GET only' }, 405);

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return json({ error: 'Schwab scan data is not configured' }, 500);
  }

  try {
    const runs = await get('scan_runs?select=*&status=eq.completed&order=completed_at.desc&limit=1');
    const run = Array.isArray(runs) ? runs[0] : null;

    if (!run) return json({ available: false, source: 'schwab' });

    const rows = await get(`scan_candidates?select=symbol&scan_run_id=eq.${encodeURIComponent(run.id)}&limit=5000`);
    const candidates = Array.isArray(rows) ? rows : [];
    const uniqueCandidateSymbols = new Set(
      candidates.map((row) => String(row.symbol || '').trim().toUpperCase()).filter(Boolean)
    ).size;

    const symbolsScanned = firstFiniteNumber(
      run.symbols_scanned,
      run.total_symbols,
      run.symbol_count,
      run.symbols_count,
      run.scanned_symbols,
      run.universe_size,
      uniqueCandidateSymbols
    );

    return json({
      available: true,
      source: 'schwab',
      completed_at: run.completed_at || run.started_at || null,
      candidates: candidates.length,
      symbols_scanned: symbolsScanned,
      scan_run_id: run.id,
    });
  } catch (error) {
    return json({ error: error.message, source: 'schwab' }, 502);
  }
};
