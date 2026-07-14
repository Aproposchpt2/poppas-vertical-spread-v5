'use strict';

const ALPHA_BASE_URL = 'https://www.alphavantage.co/query';
const API_KEY = String(process.env.ALPHA_VANTAGE_API_KEY || '').trim();

const CORS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function json(statusCode, body) {
  return { statusCode, headers: CORS, body: JSON.stringify(body) };
}

function parseSymbols(raw) {
  const list = String(raw || '')
    .toUpperCase()
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set(list)].slice(0, 25);
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
  return {
    symbol: quote['01. symbol'] || symbol,
    open: Number(quote['02. open'] || 0),
    high: Number(quote['03. high'] || 0),
    low: Number(quote['04. low'] || 0),
    price: Number(quote['05. price'] || 0),
    volume: Number(quote['06. volume'] || 0),
    latestTradingDay: quote['07. latest trading day'] || null,
    previousClose: Number(quote['08. previous close'] || 0),
    change: Number(quote['09. change'] || 0),
    changePercent: Number(String(quote['10. change percent'] || '0').replace('%', '')) || 0
  };
}

exports.handler = async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed. Use GET or POST.' });
  }
  if (!API_KEY) {
    return json(500, { error: 'Missing ALPHA_VANTAGE_API_KEY environment variable.' });
  }

  let symbolsInput = '';
  if (event.httpMethod === 'GET') {
    symbolsInput = (event.queryStringParameters || {}).symbols || '';
  } else {
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch (_) { return json(400, { error: 'Invalid JSON body.' }); }
    symbolsInput = body.symbols || '';
  }

  const symbols = Array.isArray(symbolsInput) ? symbolsInput.join(',') : symbolsInput;
  const parsedSymbols = parseSymbols(symbols);
  if (!parsedSymbols.length) {
    return json(400, { error: 'symbols is required (comma-separated or array).' });
  }

  const results = [];
  for (const symbol of parsedSymbols) {
    try {
      const quote = await fetchGlobalQuote(symbol);
      results.push({ ok: true, symbol, quote });
    } catch (error) {
      results.push({ ok: false, symbol, error: String(error.message || error) });
    }
  }

  return json(200, {
    ok: true,
    source: 'alpha-vantage',
    requested: parsedSymbols.length,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results
  });
};

