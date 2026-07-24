export default async (request, context) => {
  const response = await context.next();
  const contentType = response.headers.get('content-type') || '';

  if (!contentType.includes('text/html')) return response;

  let html = await response.text();
  const legacyMessage = 'Live data via Alpha Vantage · 15-min delay · Markets open 9:30 AM – 4:00 PM ET';
  const statusMarkup = '<span id="schwabScanStatus">⬤ Awaiting Schwab scan data</span>';

  html = html.replace(legacyMessage, statusMarkup);

  const script = `
<script>
(() => {
  const target = document.getElementById('schwabScanStatus');
  if (!target) return;

  const formatTimestamp = (value) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleString('en-US', {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });
  };

  fetch('/.netlify/functions/scan-status', { cache: 'no-store' })
    .then((response) => {
      if (!response.ok) throw new Error('Schwab status unavailable');
      return response.json();
    })
    .then((data) => {
      if (!data.available || !data.completed_at) return;

      const timestamp = formatTimestamp(data.completed_at);
      if (!timestamp) return;

      const candidates = Number(data.candidates || 0).toLocaleString('en-US');
      const symbols = Number(data.symbols_scanned || 0).toLocaleString('en-US');

      target.innerHTML =
        '<strong>⬤ Live scan: ' + timestamp + '</strong><br>' +
        'Loaded ' + candidates + ' Iron Condor candidates from ' + symbols +
        ' symbols via Schwab live data.';
    })
    .catch(() => {
      target.textContent = '⬤ Awaiting Schwab scan data';
    });
})();
</script>`;

  html = html.replace('</body>', `${script}\n</body>`);

  return new Response(html, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

export const config = { path: '/*' };
