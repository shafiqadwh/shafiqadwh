// Use BOOTH_BASE_URL / BOOTH_KEY, or the web server's BASE_URL / BOOTH_KEY.
const baseUrl = process.env.BOOTH_BASE_URL || process.env.BASE_URL;
const key = process.env.BOOTH_KEY;
try {
  if (!baseUrl || !key) throw new Error('Set BASE_URL and BOOTH_KEY in .env first.');
  const url = new URL(baseUrl);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
      || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('Use the event origin, for example https://photos.example.com, without a path or query.');
  }
  const response = await fetch(new URL('/api/booth/status', url), {
    headers: { 'x-booth-key': key }, redirect: 'error', signal: AbortSignal.timeout(10000),
  });
  if (response.status === 401) throw new Error('BOOTH_KEY does not match this event, or booth uploads are disabled.');
  if (!response.ok) throw new Error(`Server returned HTTP ${response.status}. Update the server if this is 404.`);
  const data = await response.json();
  if (data.ok !== true || data.service !== 'wedding-share-booth' || data.protocol !== 1) {
    throw new Error('The destination is not a compatible Photo Share server.');
  }
  console.log('PASS: Photo Booth can reach this event and the upload key is accepted.');
  console.log('Next: take a test photo, upload it, then scan its QR on a guest phone.');
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
}
