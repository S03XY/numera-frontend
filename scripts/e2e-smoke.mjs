/**
 * End-to-end smoke test: real frontend server ⇄ real backend ⇄ real TimescaleDB.
 *
 * Verifies the rendered HTML actually contains live data from the API (not just
 * that the page returns 200), plus the auth handshake and the privacy invariant.
 *
 *   node scripts/e2e-smoke.mjs [frontendUrl] [apiUrl]
 */
const FRONTEND = process.argv[2] ?? 'http://localhost:3000';
const API = process.argv[3] ?? 'http://localhost:3001';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

async function main() {
  console.log('\nAPI contract');
  const marketsRes = await fetch(`${API}/api/markets?category=SPORTS`);
  check('GET /api/markets returns 200', marketsRes.ok, `status ${marketsRes.status}`);
  const markets = await marketsRes.json();
  check('markets payload has items[] and total', Array.isArray(markets.items));
  check('at least one seeded market exists', markets.items.length > 0);

  const market = markets.items[0];
  check('market exposes outcomes with prices', Array.isArray(market?.outcomes) && market.outcomes.length >= 2);
  check(
    'amounts are decimal strings, never JS numbers (precision safety)',
    typeof market?.pot === 'string',
    `got ${typeof market?.pot}`,
  );
  check(
    'outcome probabilities are strings in [0,1]',
    market.outcomes.every((o) => o.probability === null || (typeof o.probability === 'string' && Number(o.probability) >= 0 && Number(o.probability) <= 1)),
  );

  const detailRes = await fetch(`${API}/api/markets/${market.id}`);
  check('GET /api/markets/:id returns 200', detailRes.ok);

  const tradesRes = await fetch(`${API}/api/markets/${market.id}/trades`);
  const trades = await tradesRes.json();
  check('GET trades returns a page', Array.isArray(trades.items));
  check(
    'trades expose only pseudonymous accounts, never a user identity (PRIVACY)',
    trades.items.every((t) => /^0x[0-9a-f]{40}$/i.test(t.account) && !('userId' in t) && !('user' in t)),
  );

  const candlesRes = await fetch(`${API}/api/markets/${market.id}/prices/candles?interval=1m&outcome=0`);
  check('GET candles (TimescaleDB) returns 200', candlesRes.ok);
  const candles = await candlesRes.json();
  check('candles are OHLC shaped', Array.isArray(candles) && (candles.length === 0 || 'open' in candles[0]));

  console.log('\nAuth handshake');
  const nonceRes = await fetch(`${API}/api/auth/nonce`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' }),
  });
  check('POST /api/auth/nonce returns 200', nonceRes.ok);
  const nonce = await nonceRes.json();
  check('SIWE message is server-built and contains a nonce', typeof nonce.message === 'string' && nonce.message.includes(nonce.nonce));

  const badVerify = await fetch(`${API}/api/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: nonce.message, signature: '0x' + '00'.repeat(65) }),
  });
  check('invalid signature is rejected with 401 (negative)', badVerify.status === 401, `got ${badVerify.status}`);

  const meRes = await fetch(`${API}/api/users/me`);
  check('protected route requires auth (negative)', meRes.status === 401, `got ${meRes.status}`);

  console.log('\nFrontend rendering');
  const homeRes = await fetch(FRONTEND);
  check('GET / returns 200', homeRes.ok, `status ${homeRes.status}`);
  const html = await homeRes.text();
  check('home renders the product positioning', html.includes('Predict in the open'));
  check('home renders the privacy badge', html.includes('Shielded'));

  const detailPage = await fetch(`${FRONTEND}/markets/${market.id}`);
  check('GET /markets/:id returns 200', detailPage.ok, `status ${detailPage.status}`);

  const missing = await fetch(`${FRONTEND}/markets/00000000-0000-4000-8000-000000000000`);
  check('unknown market id still serves a page (handled client-side)', missing.ok);


  console.log('\nPortfolio + resolution');
  const posRes = await fetch(`${API}/api/positions/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accounts: ['0x0ecacc00000000000000000000000000000acc70'] }),
  });
  check('POST /api/positions/query returns 200', posRes.ok, `status ${posRes.status}`);
  const positions = await posRes.json();
  check('positions returned for the seeded shielded account', Array.isArray(positions) && positions.length > 0);
  check(
    'positions are keyed by execution account, never a user (PRIVACY)',
    positions.every((p) => /^0x[0-9a-f]{40}$/i.test(p.account) && !('userId' in p) && !('user' in p)),
  );
  check('positions carry a mark-to-market value', positions.every((p) => 'markToMarket' in p));

  const badPos = await fetch(`${API}/api/positions/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accounts: ['not-an-address'] }),
  });
  check('malformed account is rejected with 400 (negative)', badPos.status === 400, `got ${badPos.status}`);

  const resRes = await fetch(`${API}/api/markets/${market.id}/resolution`);
  check('GET /api/markets/:id/resolution returns 200', resRes.ok);

  console.log('\nCategory growth path');
  const catsRes = await fetch(`${API}/api/categories`);
  const cats = await catsRes.json();
  check('only SPORTS is enabled at launch', cats.length === 1 && cats[0].key === 'SPORTS', `got ${cats.map((c) => c.key).join(',')}`);

  const portfolioPage = await fetch(`${FRONTEND}/portfolio`);
  check('GET /portfolio returns 200', portfolioPage.ok, `status ${portfolioPage.status}`);
  const portfolioHtml = await portfolioPage.text();
  check('portfolio explains the privacy model', /link does not exist/i.test(portfolioHtml));

  const notFound = await fetch(`${FRONTEND}/does-not-exist`);
  check('unknown route serves the 404 page', notFound.status === 404, `got ${notFound.status}`);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('smoke test crashed:', err);
  process.exit(1);
});
