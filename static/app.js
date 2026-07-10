const state = {
  results: [],
  filteredResults: [],
  selected: null,
  mode: "demo",
  journal: JSON.parse(localStorage.getItem("poppasVerticalJournal") || "[]"),
};

const els = Object.fromEntries([
  "scannerForm", "watchlist", "strategy", "dteRange", "ivRank", "ivRankOutput", "minRor", "rorOutput",
  "minOi", "maxBidAsk", "avoidEarnings", "directionalConfirmation", "runButton", "resetButton", "scannerStatus",
  "symbolCount", "qualifiedCount", "topScore", "metricScanned", "metricQualified", "metricRor", "metricScore",
  "resultsSummary", "emptyState", "tableWrap", "resultsBody", "resultSearch", "sortResults", "exportButton",
  "biasChart", "scoreChart", "alertThreshold", "alertsList", "dataModeLabel", "detailDrawer", "drawerBackdrop",
  "closeDrawer", "drawerTitle", "drawerContent", "journalNavButton", "journalCount", "journalDialog", "journalEntries",
  "closeJournal", "themeButton"
].map(id => [id, document.getElementById(id)]));

const DEFAULTS = {
  watchlist: "AAPL, MSFT, NVDA, AMZN, META, GOOGL, TSLA, AMD, NFLX, CRWD, SPY, QQQ, IWM, GLD, XLF, XLE, XLK, BABA, CRM, ORCL, AVGO, QCOM, MU, TXN, INTC, CSCO, JPM, BAC, GS, MS, WFC, V, MA, PYPL, SQ, AMGN, MRNA, PFE, JNJ, UNH, BA, CAT, GE, HON, DE, UBER, COIN, SHOP, SPOT, SNAP",
  strategy: "auto",
  dteRange: "21-45",
  ivRank: 20,
  minRor: 15,
  minOi: 100,
  maxBidAsk: "0.25",
};

function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

function seededUnit(seed, salt = 0) {
  const x = Math.sin(seed * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function parseTickers(raw) {
  return [...new Set(raw.toUpperCase().split(/[\s,;]+/).map(v => v.trim()).filter(Boolean))].slice(0, 25);
}

function formatMoney(value) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
}

function formatPercent(value, digits = 0) {
  return `${(Number(value) * 100).toFixed(digits)}%`;
}

function expirationFromDte(dte) {
  const date = new Date();
  date.setDate(date.getDate() + dte);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function priceForTicker(ticker, seed) {
  const anchors = { NVDA: 178, MSFT: 514, AAPL: 231, CRWD: 445, AMZN: 223, META: 688, TSLA: 346, GOOGL: 198, AMD: 172, NFLX: 1260, SPY: 628, QQQ: 565 };
  return anchors[ticker] || Math.round(45 + seededUnit(seed, 2) * 420);
}

function createDemoCandidate(ticker, index, config) {
  const seed = hashString(`${ticker}-${config.dteRange}-${config.strategy}`);
  const price = priceForTicker(ticker, seed);
  const rawBias = seededUnit(seed, 4) * 1.7 - 0.85;
  const biasScore = Math.max(-1, Math.min(1, rawBias));
  const forceBull = config.strategy === "bull_put";
  const forceBear = config.strategy === "bear_call";
  const bullish = forceBull || (!forceBear && biasScore >= 0);
  const spreadType = bullish ? "Bull Put Credit" : "Bear Call Credit";
  const biasLabel = Math.abs(biasScore) > .62 ? `Strong ${bullish ? "Bullish" : "Bearish"}` : bullish ? "Bullish" : "Bearish";
  const range = config.dteRange.split("-").map(Number);
  const dte = Math.round(range[0] + seededUnit(seed, 5) * (range[1] - range[0]));
  const widthChoices = price > 400 ? [5, 10, 15] : price > 150 ? [2.5, 5, 10] : [1, 2.5, 5];
  const width = widthChoices[Math.floor(seededUnit(seed, 6) * widthChoices.length)];
  const cushion = Math.max(width * 1.2, price * (0.035 + seededUnit(seed, 7) * .05));
  const shortStrikeRaw = bullish ? price - cushion : price + cushion;
  const strikeStep = width >= 5 ? 5 : width;
  const shortStrike = Math.round(shortStrikeRaw / strikeStep) * strikeStep;
  const longStrike = bullish ? shortStrike - width : shortStrike + width;
  const ror = .11 + seededUnit(seed, 8) * .46;
  const maxRiskPerShare = width / (1 + ror);
  const creditPerShare = width - maxRiskPerShare;
  const credit = Math.round(creditPerShare * 100);
  const maxRisk = Math.round(maxRiskPerShare * 100);
  const ivRank = .16 + seededUnit(seed, 9) * .68;
  const ivPercentile = Math.min(.97, ivRank + (seededUnit(seed, 10) - .5) * .18);
  const openInterest = Math.round(80 + seededUnit(seed, 11) * 4800);
  const bidAskPct = .05 + seededUnit(seed, 12) * .28;
  const earningsDays = Math.round(3 + seededUnit(seed, 13) * 65);
  const score = Math.max(0, Math.min(1,
    .42 * Math.min(ror / .55, 1) +
    .24 * Math.abs(biasScore) +
    .22 * ivRank +
    .12 * Math.min(openInterest / 2500, 1) -
    Math.max(0, bidAskPct - .18) * .6
  ));
  const breakeven = bullish ? shortStrike - creditPerShare : shortStrike + creditPerShare;
  const maxProfit = credit;
  const probabilityEstimate = Math.max(.51, Math.min(.88, .58 + cushion / price * 1.7 + seededUnit(seed, 14) * .08));

  return {
    ticker, price, bias_score: biasScore, bias_label: biasLabel, spread_type: spreadType,
    expiration: expirationFromDte(dte), dte, short_strike: shortStrike, long_strike: longStrike,
    width, credit, max_risk: maxRisk, max_profit: maxProfit, return_on_risk: credit / maxRisk,
    breakeven, iv_rank: ivRank, iv_percentile: ivPercentile, open_interest: openInterest,
    bid_ask_pct: bidAskPct, earnings_days: earningsDays, probability_estimate: probabilityEstimate,
    score, sector: ["Technology", "Communication Services", "Consumer Cyclical", "Financial Services"][seed % 4],
    liquidity: bidAskPct <= .12 ? "Excellent" : bidAskPct <= .22 ? "Good" : "Fair",
    rank: index + 1,
  };
}

function buildDemoResults(tickers, config) {
  const candidates = tickers.map((ticker, index) => createDemoCandidate(ticker, index, config));
  return candidates.filter(row => {
    if (row.iv_rank * 100 < config.ivRank) return false;
    if (row.return_on_risk * 100 < config.minRor) return false;
    if (row.open_interest < config.minOi) return false;
    if (row.bid_ask_pct > config.maxBidAsk) return false;
    if (config.avoidEarnings && row.earnings_days <= 7) return false;
    if (config.directionalConfirmation && config.strategy === "auto" && Math.abs(row.bias_score) < .08) return false;
    return true;
  }).sort((a, b) => b.score - a.score).map((row, index) => ({ ...row, rank: index + 1 }));
}

function getConfig() {
  return {
    watchlist: parseTickers(els.watchlist.value),
    strategy: els.strategy.value,
    dteRange: els.dteRange.value,
    ivRank: Number(els.ivRank.value),
    minRor: Number(els.minRor.value),
    minOi: Number(els.minOi.value),
    maxBidAsk: Number(els.maxBidAsk.value),
    avoidEarnings: els.avoidEarnings.checked,
    directionalConfirmation: els.directionalConfirmation.checked,
  };
}

async function fetchLiveResults(config) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch("/.netlify/functions/scan-vertical", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        tickers: config.watchlist,
        strategy: config.strategy,
        dte_min: Number(config.dteRange.split("-")[0]),
        dte_max: Number(config.dteRange.split("-")[1]),
        min_iv_rank: config.ivRank / 100,
        min_ror: config.minRor / 100,
        min_open_interest: config.minOi,
        max_bid_ask_pct: config.maxBidAsk,
        avoid_earnings: config.avoidEarnings,
      }),
    });
    if (!response.ok) throw new Error(`API ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload.results)) throw new Error("Invalid response");
    state.mode = payload.mode || "live";
    return payload.results;
  } finally {
    clearTimeout(timeout);
  }
}

async function runScanner(event) {
  event?.preventDefault();
  const config = getConfig();
  if (!config.watchlist.length) {
    els.watchlist.focus();
    els.scannerStatus.textContent = "Add symbols";
    return;
  }

  setLoading(true);
  els.symbolCount.textContent = config.watchlist.length;
  els.scannerStatus.textContent = "Scanning";
  let results;
  try {
    results = await fetchLiveResults(config);
    state.mode = "live";
  } catch (error) {
    await new Promise(resolve => setTimeout(resolve, 550));
    results = buildDemoResults(config.watchlist, config);
    state.mode = "demo";
  }

  state.results = results.sort((a, b) => b.score - a.score).map((row, index) => ({ ...row, rank: index + 1 }));
  state.filteredResults = [...state.results];
  els.dataModeLabel.textContent = state.mode === "live" ? "Live Data Mode" : "Interactive Demo Mode";
  els.scannerStatus.textContent = "Complete";
  renderAll(config.watchlist.length);
  setLoading(false);
}

function setLoading(isLoading) {
  els.runButton.classList.toggle("loading", isLoading);
  els.runButton.disabled = isLoading;
}

function renderAll(scannedCount) {
  applySearchAndSort();
  const rows = state.results;
  const avgRor = rows.length ? rows.reduce((sum, row) => sum + Number(row.return_on_risk), 0) / rows.length : 0;
  const avgScore = rows.length ? rows.reduce((sum, row) => sum + Number(row.score), 0) / rows.length : 0;
  els.metricScanned.textContent = scannedCount;
  els.metricQualified.textContent = rows.length;
  els.qualifiedCount.textContent = rows.length;
  els.metricRor.textContent = rows.length ? formatPercent(avgRor) : "—";
  els.metricScore.textContent = rows.length ? Math.round(avgScore * 100) : "—";
  els.topScore.textContent = rows.length ? Math.round(rows[0].score * 100) : "—";
  els.resultsSummary.textContent = rows.length ? `${rows.length} candidate${rows.length === 1 ? "" : "s"} passed the current filters.` : "No spreads passed the current filters.";
  els.emptyState.classList.toggle("hidden", rows.length > 0);
  els.tableWrap.classList.toggle("hidden", rows.length === 0);
  els.exportButton.disabled = rows.length === 0;
  renderCharts();
  renderAlerts();
}

function applySearchAndSort() {
  const query = els.resultSearch.value.trim().toLowerCase();
  const sort = els.sortResults.value;
  let rows = state.results.filter(row => `${row.ticker} ${row.spread_type} ${row.bias_label}`.toLowerCase().includes(query));
  rows.sort((a, b) => {
    if (sort === "ror-desc") return b.return_on_risk - a.return_on_risk;
    if (sort === "credit-desc") return b.credit - a.credit;
    if (sort === "dte-asc") return a.dte - b.dte;
    return b.score - a.score;
  });
  state.filteredResults = rows;
  renderTable();
}

function badgeClass(label) {
  if (label.toLowerCase().includes("bull")) return "bullish";
  if (label.toLowerCase().includes("bear")) return "bearish";
  return "neutral";
}

function renderTable() {
  els.resultsBody.innerHTML = state.filteredResults.map((row, index) => `
    <tr>
      <td>${index + 1}</td>
      <td class="symbol-cell"><strong>${row.ticker}</strong><small>${formatMoney(row.price)}</small></td>
      <td><span class="badge ${badgeClass(row.bias_label)}">${row.bias_label}</span><div class="sub-value">${Number(row.bias_score).toFixed(2)}</div></td>
      <td>${row.spread_type}</td>
      <td>${row.expiration}<div class="sub-value">${row.dte} DTE</div></td>
      <td>${formatStrike(row.short_strike)} / ${formatStrike(row.long_strike)}<div class="sub-value">${formatStrike(row.width)} wide</div></td>
      <td class="positive">${formatMoney(row.credit)}</td>
      <td>${formatMoney(row.max_risk)}</td>
      <td class="positive">${formatPercent(row.return_on_risk)}</td>
      <td>${formatPercent(row.iv_rank)}</td>
      <td><span class="score-pill">${Math.round(row.score * 100)}</span></td>
      <td><button class="row-action" data-index="${state.results.indexOf(row)}">Analyze</button></td>
    </tr>
  `).join("");

  els.resultsBody.querySelectorAll(".row-action").forEach(button => {
    button.addEventListener("click", () => openDetail(Number(button.dataset.index)));
  });
}

function formatStrike(value) {
  return Number.isInteger(Number(value)) ? Number(value).toFixed(0) : Number(value).toFixed(1);
}

function renderCharts() {
  const rows = state.results.slice(0, 8);
  if (!rows.length) {
    els.biasChart.className = "bar-chart chart-placeholder";
    els.scoreChart.className = "bar-chart chart-placeholder";
    els.biasChart.innerHTML = "<span>Awaiting qualifying candidates</span>";
    els.scoreChart.innerHTML = "<span>Awaiting qualifying candidates</span>";
    return;
  }
  els.biasChart.className = "bar-chart";
  els.scoreChart.className = "bar-chart";
  els.biasChart.innerHTML = rows.map(row => {
    const height = Math.max(6, Math.abs(row.bias_score) * 100);
    return `<div class="bar-column"><small>${Number(row.bias_score).toFixed(2)}</small><div class="bar-track"><div class="bar-fill ${row.bias_score < 0 ? "bear" : ""}" style="height:${height}%"></div></div><strong>${row.ticker}</strong></div>`;
  }).join("");
  els.scoreChart.innerHTML = rows.map(row => {
    return `<div class="bar-column"><small>${Math.round(row.score * 100)}</small><div class="bar-track"><div class="bar-fill" style="height:${Math.max(6, row.score * 100)}%"></div></div><strong>${row.ticker}</strong></div>`;
  }).join("");
}

function renderAlerts() {
  const threshold = Number(els.alertThreshold.value) / 100;
  const alerts = state.results.filter(row => row.score >= threshold);
  if (!alerts.length) {
    els.alertsList.innerHTML = '<p class="muted">No candidates meet the current alert threshold.</p>';
    return;
  }
  els.alertsList.innerHTML = alerts.map((row, index) => `
    <button class="alert-row" data-index="${state.results.indexOf(row)}" type="button">
      <span class="alert-rank">${index + 1}</span>
      <span><strong>${row.ticker} · ${row.spread_type}</strong><small>${formatStrike(row.short_strike)} / ${formatStrike(row.long_strike)} · ${formatPercent(row.return_on_risk)} ROR · ${row.dte} DTE</small></span>
      <span class="score-pill">${Math.round(row.score * 100)}</span>
    </button>
  `).join("");
  els.alertsList.querySelectorAll(".alert-row").forEach(button => button.addEventListener("click", () => openDetail(Number(button.dataset.index))));
}

function createPayoffSvg(row) {
  const width = 470, height = 240, pad = 38;
  const spreadWidth = Number(row.width);
  const minPrice = Math.min(row.short_strike, row.long_strike) - spreadWidth * 2.2;
  const maxPrice = Math.max(row.short_strike, row.long_strike) + spreadWidth * 2.2;
  const maxProfit = Number(row.credit);
  const maxLoss = Number(row.max_risk);
  const points = [];
  for (let i = 0; i <= 70; i += 1) {
    const price = minPrice + (maxPrice - minPrice) * i / 70;
    let pnl;
    if (row.spread_type.includes("Bull Put")) {
      if (price >= row.short_strike) pnl = maxProfit;
      else if (price <= row.long_strike) pnl = -maxLoss;
      else pnl = maxProfit - (row.short_strike - price) * 100;
    } else {
      if (price <= row.short_strike) pnl = maxProfit;
      else if (price >= row.long_strike) pnl = -maxLoss;
      else pnl = maxProfit - (price - row.short_strike) * 100;
    }
    const x = pad + (price - minPrice) / (maxPrice - minPrice) * (width - pad * 2);
    const y = pad + (maxProfit - pnl) / (maxProfit + maxLoss) * (height - pad * 2);
    points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  const zeroY = pad + maxProfit / (maxProfit + maxLoss) * (height - pad * 2);
  const shortX = pad + (row.short_strike - minPrice) / (maxPrice - minPrice) * (width - pad * 2);
  const longX = pad + (row.long_strike - minPrice) / (maxPrice - minPrice) * (width - pad * 2);
  return `
    <svg class="payoff-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Expiration payoff diagram">
      <line x1="${pad}" y1="${zeroY}" x2="${width-pad}" y2="${zeroY}" stroke="rgba(154,169,186,.45)" stroke-dasharray="5 5" />
      <line x1="${shortX}" y1="${pad}" x2="${shortX}" y2="${height-pad}" stroke="rgba(212,181,106,.30)" />
      <line x1="${longX}" y1="${pad}" x2="${longX}" y2="${height-pad}" stroke="rgba(212,181,106,.18)" />
      <polyline points="${points.join(" ")}" fill="none" stroke="#d4b56a" stroke-width="3" stroke-linejoin="round" />
      <text x="${pad}" y="18" fill="#55d6a9" font-size="10">Max profit ${formatMoney(maxProfit)}</text>
      <text x="${width-pad}" y="${height-8}" fill="#ff7b83" font-size="10" text-anchor="end">Max loss ${formatMoney(maxLoss)}</text>
      <text x="${shortX}" y="${height-14}" fill="#9aa9ba" font-size="9" text-anchor="middle">Short ${formatStrike(row.short_strike)}</text>
      <text x="${longX}" y="${height-2}" fill="#9aa9ba" font-size="9" text-anchor="middle">Long ${formatStrike(row.long_strike)}</text>
    </svg>`;
}

function openDetail(index) {
  const row = state.results[index];
  if (!row) return;
  state.selected = row;
  els.drawerTitle.textContent = `${row.ticker} spread analysis`;
  els.drawerContent.innerHTML = `
    <div class="detail-hero">
      <div><div class="detail-symbol">${row.ticker}</div><span class="badge ${badgeClass(row.bias_label)}">${row.bias_label}</span></div>
      <div class="detail-score">${Math.round(row.score * 100)}</div>
    </div>
    <div class="detail-grid">
      ${detailStat("Strategy", row.spread_type)}
      ${detailStat("Expiration", `${row.expiration} · ${row.dte} DTE`)}
      ${detailStat("Short / long strikes", `${formatStrike(row.short_strike)} / ${formatStrike(row.long_strike)}`)}
      ${detailStat("Net credit", formatMoney(row.credit))}
      ${detailStat("Maximum risk", formatMoney(row.max_risk))}
      ${detailStat("Return on risk", formatPercent(row.return_on_risk))}
      ${detailStat("Breakeven", formatStrike(row.breakeven))}
      ${detailStat("Estimated POP", formatPercent(row.probability_estimate))}
      ${detailStat("IV rank", formatPercent(row.iv_rank))}
      ${detailStat("Liquidity", `${row.liquidity} · ${row.open_interest.toLocaleString()} OI`)}
    </div>
    <div class="payoff-card"><h3>Expiration payoff profile</h3>${createPayoffSvg(row)}</div>
    <div class="analysis-notes"><strong>Research interpretation:</strong> This candidate is ranked from return on risk, directional alignment, IV rank, and liquidity. The estimate does not account for commissions, assignment risk, volatility changes after entry, or intraday execution slippage.</div>
    <div class="drawer-actions">
      <button class="primary-button" id="saveToJournal" type="button">Save to trade journal</button>
      <button class="ghost-button" id="copySpread" type="button">Copy spread</button>
    </div>`;
  els.detailDrawer.classList.add("open");
  els.detailDrawer.setAttribute("aria-hidden", "false");
  els.drawerBackdrop.hidden = false;
  document.body.style.overflow = "hidden";
  document.getElementById("saveToJournal").addEventListener("click", () => saveToJournal(row));
  document.getElementById("copySpread").addEventListener("click", () => copySpread(row));
}

function detailStat(label, value) {
  return `<div class="detail-stat"><span>${label}</span><strong>${value}</strong></div>`;
}

function closeDetail() {
  els.detailDrawer.classList.remove("open");
  els.detailDrawer.setAttribute("aria-hidden", "true");
  els.drawerBackdrop.hidden = true;
  document.body.style.overflow = "";
}

function saveToJournal(row) {
  const key = `${row.ticker}-${row.expiration}-${row.short_strike}-${row.long_strike}`;
  if (!state.journal.some(item => item.key === key)) {
    state.journal.unshift({ key, savedAt: new Date().toISOString(), ...row });
    localStorage.setItem("poppasVerticalJournal", JSON.stringify(state.journal));
    renderJournalCount();
  }
  const button = document.getElementById("saveToJournal");
  button.textContent = "Saved";
  button.disabled = true;
}

async function copySpread(row) {
  const text = `${row.ticker} ${row.spread_type}: Sell ${formatStrike(row.short_strike)} / Buy ${formatStrike(row.long_strike)}, ${row.expiration}, credit ${formatMoney(row.credit)}, max risk ${formatMoney(row.max_risk)}, ROR ${formatPercent(row.return_on_risk)}.`;
  try { await navigator.clipboard.writeText(text); } catch { /* browser may block clipboard */ }
  const button = document.getElementById("copySpread");
  button.textContent = "Copied";
}

function renderJournalCount() {
  els.journalCount.textContent = state.journal.length;
}

function openJournal() {
  if (!state.journal.length) {
    els.journalEntries.innerHTML = '<p class="muted">No candidates have been saved.</p>';
  } else {
    els.journalEntries.innerHTML = state.journal.map((row, index) => `
      <div class="journal-entry">
        <div><strong>${row.ticker} · ${row.spread_type}</strong><small>${formatStrike(row.short_strike)} / ${formatStrike(row.long_strike)} · ${row.expiration} · ${formatPercent(row.return_on_risk)} ROR</small></div>
        <button class="delete-journal" data-index="${index}" type="button">Remove</button>
      </div>`).join("");
    els.journalEntries.querySelectorAll(".delete-journal").forEach(button => button.addEventListener("click", () => {
      state.journal.splice(Number(button.dataset.index), 1);
      localStorage.setItem("poppasVerticalJournal", JSON.stringify(state.journal));
      renderJournalCount();
      openJournal();
    }));
  }
  if (!els.journalDialog.open) els.journalDialog.showModal();
}

function exportCsv() {
  if (!state.filteredResults.length) return;
  const headers = ["ticker","bias_label","spread_type","expiration","dte","short_strike","long_strike","credit","max_risk","return_on_risk","iv_rank","open_interest","score"];
  const rows = state.filteredResults.map(row => headers.map(key => JSON.stringify(row[key] ?? "")).join(","));
  const blob = new Blob([[headers.join(","), ...rows].join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `poppas-vertical-spread-scan-${new Date().toISOString().slice(0,10)}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function resetForm() {
  els.watchlist.value = DEFAULTS.watchlist;
  els.strategy.value = DEFAULTS.strategy;
  els.dteRange.value = DEFAULTS.dteRange;
  els.ivRank.value = DEFAULTS.ivRank;
  els.minRor.value = DEFAULTS.minRor;
  els.minOi.value = DEFAULTS.minOi;
  els.maxBidAsk.value = DEFAULTS.maxBidAsk;
  els.avoidEarnings.checked = true;
  els.directionalConfirmation.checked = true;
  els.ivRankOutput.value = `${DEFAULTS.ivRank}%`;
  els.rorOutput.value = `${DEFAULTS.minRor}%`;
}

els.scannerForm.addEventListener("submit", runScanner);
els.ivRank.addEventListener("input", () => { els.ivRankOutput.value = `${els.ivRank.value}%`; });
els.minRor.addEventListener("input", () => { els.rorOutput.value = `${els.minRor.value}%`; });
els.watchlist.addEventListener("input", () => { els.symbolCount.textContent = parseTickers(els.watchlist.value).length; });
els.resultSearch.addEventListener("input", applySearchAndSort);
els.sortResults.addEventListener("change", applySearchAndSort);
els.alertThreshold.addEventListener("input", renderAlerts);
els.exportButton.addEventListener("click", exportCsv);
els.resetButton.addEventListener("click", resetForm);
els.closeDrawer.addEventListener("click", closeDetail);
els.drawerBackdrop.addEventListener("click", closeDetail);
els.journalNavButton.addEventListener("click", openJournal);
els.closeJournal.addEventListener("click", () => els.journalDialog.close());
els.themeButton.addEventListener("click", () => document.body.classList.toggle("light"));
document.addEventListener("keydown", event => { if (event.key === "Escape") closeDetail(); });

renderJournalCount();
els.symbolCount.textContent = parseTickers(els.watchlist.value).length;
