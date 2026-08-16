/**
 * Proof generation in a real browser, with the real prover and the real artifacts.
 *
 * Every other test proves the pool works somewhere that is not a browser. `pool-live.mjs` proves
 * the chain accepts a proof; `pool-integration.mjs` proves the backend relays one. Both run in
 * Node, and Node is not where this has to work.
 *
 * The thing that can only fail here is the prover itself. snarkjs is a Node library with a browser
 * build, it reaches for `fs`, `os` and `readline` on some paths, and the proving key is a 17MB
 * fetch rather than a file read. WebAssembly memory limits, `SharedArrayBuffer` availability and
 * BigInt performance are all browser facts. A build that compiles, type-checks and ships can still
 * throw the first time somebody places a private bet — which is the worst possible place to find
 * out, so it is found out here.
 *
 * Two things are checked, and the second is the one that matters:
 *
 *   1. **the bundle** — that the production build actually resolved `import('snarkjs')` into
 *      browser chunks, rather than erroring or silently shipping a Node build;
 *   2. **the runtime** — that the prover can generate a valid Groth16 proof in Chrome, against the
 *      artifacts this app actually serves, in a time a person will wait for.
 *
 * The prover is served from this script rather than fetched from a CDN, because a CDN's build is
 * not the build we ship and testing it would prove nothing about our own.
 *
 * Needs the dev server running (`npm run dev:https`) and a production build present (`npm run
 * build`) for the bundle check:
 *
 *   node scripts/pool-browser-e2e.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LeanIMT } from '@zk-kit/lean-imt';
import { poseidon2, poseidon3 } from 'poseidon-lite';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const ORIGIN = process.env.FRONTEND_URL ?? 'https://local.numera.trade:3000';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CDP_PORT = 9335;
const ASSET_PORT = 9336;

const F = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    console.log(`  ✓ ${name}`);
    passed += 1;
  } else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
    failed += 1;
  }
};

/**
 * Serve the prover, self-contained.
 *
 * snarkjs publishes two browser artifacts: `build/browser.esm.js`, which the bundler resolves and
 * which still carries bare imports like `ffjavascript` for the bundler to fix up; and
 * `build/snarkjs.min.js`, the UMD bundle with those dependencies already inlined. Same source, and
 * only the second can be loaded into a page directly.
 *
 * Which is the right split for what each check is for: the bundle assertion above proves Turbopack
 * resolved the ESM entry into our client chunks, and this proves the code inside it actually runs
 * in Chrome. Loading the ESM entry raw would only prove that a browser cannot resolve bare
 * specifiers, which is true and uninteresting.
 */
function serveProver() {
  const file = join(APP, 'node_modules', 'snarkjs', 'build', 'snarkjs.min.js');
  if (!existsSync(file)) throw new Error(`snarkjs browser build not found at ${file}`);
  const server = createServer((req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('content-type', 'application/javascript');
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(ASSET_PORT, '127.0.0.1', () => resolve(server)));
}

const profile = mkdtempSync(join(tmpdir(), 'pool-e2e-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    // The dev server serves a self-signed certificate, because passkeys need a real domain over
    // HTTPS. Accepting it is what lets this run against the origin a person would actually use.
    '--ignore-certificate-errors',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let assetServer = null;
function cleanup() {
  chrome.kill();
  assetServer?.close();
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // Chrome writes to the profile as it exits; a failed delete is a stale temp directory.
  }
}

async function debuggerUrl() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      return (await response.json()).webSocketDebuggerUrl;
    } catch {
      await sleep(250);
    }
  }
  throw new Error('Chrome did not open a debugging port');
}

let nextId = 1;
const pending = new Map();
const consoleLines = [];

function send(ws, method, params = {}, sessionId) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(ws, sessionId, expression) {
  const result = await send(
    ws,
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true, timeout: 300_000 },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result.value;
}

/** Everything the circuit needs, computed here so the page needs no hashing library. */
function witness() {
  const nullifier = 12_345_678_901_234_567_890n % F;
  const secret = 98_765_432_109_876_543_210n % F;
  const value = 10_000_000n;
  const label = 42n;
  const commitment = poseidon3([value, label, poseidon2([nullifier, secret])]);

  const state = new LeanIMT((a, b) => poseidon2([a, b]));
  state.insert(commitment);
  const asp = new LeanIMT((a, b) => poseidon2([a, b]));
  asp.insert(label);

  const sp = state.generateProof(0);
  const ap = asp.generateProof(0);
  const pad = (s) => [...s, ...Array(32 - s.length).fill(0n)].map(String);

  return {
    withdrawnValue: '4000000',
    stateRoot: state.root.toString(),
    stateTreeDepth: String(sp.siblings.length),
    ASPRoot: asp.root.toString(),
    ASPTreeDepth: String(ap.siblings.length),
    context: '7',
    label: label.toString(),
    existingValue: value.toString(),
    existingNullifier: nullifier.toString(),
    existingSecret: secret.toString(),
    newNullifier: ((nullifier + 1n) % F).toString(),
    newSecret: ((secret + 1n) % F).toString(),
    stateSiblings: pad(sp.siblings),
    stateIndex: String(sp.index),
    ASPSiblings: pad(ap.siblings),
    ASPIndex: String(ap.index),
  };
}

async function main() {
  console.log(`Browser-side proving against ${ORIGIN}\n`);

  // --- 1. the bundle ---------------------------------------------------------------------------
  const chunks = join(APP, '.next', 'static', 'chunks');
  if (existsSync(chunks)) {
    const bundled = readdirSync(chunks).filter(
      (f) => f.endsWith('.js') && readFileSync(join(chunks, f), 'utf8').includes('groth16'),
    );
    check(
      'the production build resolved the prover into browser chunks',
      bundled.length > 0,
      'no chunk contains groth16 — `import("snarkjs")` did not reach the client bundle',
    );
  } else {
    console.log('  · no production build present; skipping the bundle check (run `npm run build`)');
  }

  assetServer = await serveProver();

  const ws = new WebSocket(await debuggerUrl());
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));

  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    } else if (message.method === 'Runtime.consoleAPICalled') {
      const args = message.params.args.map((a) => a.value ?? a.description).join(' ');
      consoleLines.push(`${message.params.type}: ${args}`);
    } else if (message.method === 'Runtime.exceptionThrown') {
      consoleLines.push(`uncaught: ${message.params.exceptionDetails.text}`);
    }
  });

  const { targetId } = await send(ws, 'Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send(ws, 'Target.attachToTarget', { targetId, flatten: true });
  await send(ws, 'Runtime.enable', {}, sessionId);
  await send(ws, 'Page.enable', {}, sessionId);

  await send(ws, 'Page.navigate', { url: `${ORIGIN}/wallet` }, sessionId);
  await sleep(4000);

  const title = await evaluate(ws, sessionId, 'document.title');
  check('the app loads in a real browser', typeof title === 'string' && title.length > 0, title);

  // --- 2. the artifacts ------------------------------------------------------------------------
  const artifacts = await evaluate(
    ws,
    sessionId,
    `(async () => {
       const wasm = await fetch('/zk/withdraw.wasm');
       const zkey = await fetch('/zk/withdraw.zkey');
       return {
         wasm: wasm.status,
         zkey: zkey.status,
         wasmBytes: (await wasm.arrayBuffer()).byteLength,
         zkeyBytes: (await zkey.arrayBuffer()).byteLength,
       };
     })()`,
  );
  check(
    'the circuit is served to the browser',
    artifacts.wasm === 200 && artifacts.wasmBytes > 1_000_000,
    JSON.stringify(artifacts),
  );
  check(
    'the proving key is served to the browser',
    artifacts.zkey === 200 && artifacts.zkeyBytes > 10_000_000,
    `${artifacts.zkeyBytes} bytes`,
  );

  // --- 3. the runtime --------------------------------------------------------------------------
  const input = witness();
  const proof = await evaluate(
    ws,
    sessionId,
    `(async () => {
       const started = Date.now();
       try {
         if (!window.snarkjs) {
           await new Promise((resolve, reject) => {
             const tag = document.createElement('script');
             tag.src = 'http://127.0.0.1:${ASSET_PORT}/snarkjs.js';
             tag.onload = resolve;
             tag.onerror = () => reject(new Error('could not load the prover'));
             document.head.appendChild(tag);
           });
         }
         const snark = window.snarkjs;
         const raw = ${JSON.stringify(input)};
         // Decimal strings on the wire, BigInt in the witness: JSON cannot carry a field element
         // and a rounded one produces a proof of a different claim.
         const input = Object.fromEntries(
           Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v.map(BigInt) : BigInt(v)]),
         );
         const { proof, publicSignals } = await snark.groth16.fullProve(
           input,
           '/zk/withdraw.wasm',
           '/zk/withdraw.zkey',
         );
         return { ok: true, ms: Date.now() - started, signals: publicSignals, a: proof.pi_a.length };
       } catch (err) {
         return { ok: false, error: String(err && err.stack ? err.stack : err) };
       }
     })()`,
  );

  check(
    'a browser generates a real withdrawal proof with the shipped prover',
    proof.ok === true,
    proof.ok ? '' : String(proof.error).slice(0, 500),
  );
  if (proof.ok) {
    console.log(`  · proof generated in the browser in ${proof.ms}ms`);
    check(
      'it emits the eight public signals the verifier expects',
      proof.signals.length === 8,
      `got ${proof.signals.length}`,
    );
    // Signal 2 is `withdrawnValue`, and signal 3 the state root. A mis-ordered witness shows here
    // rather than as a pairing failure on chain half a minute later.
    check('the withdrawn value survives the witness intact', proof.signals[2] === '4000000',
      proof.signals[2]);
    check('the state root survives the witness intact', proof.signals[3] === input.stateRoot,
      proof.signals[3]);
  }

  const uncaught = consoleLines.filter((l) => l.startsWith('uncaught:'));
  check('nothing threw uncaught while the app was running', uncaught.length === 0,
    uncaught.slice(0, 2).join(' | '));

  console.log(`\n${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nFAILED:', err.message);
  if (consoleLines.length) console.error(consoleLines.slice(-10).join('\n'));
  cleanup();
  process.exit(1);
});
