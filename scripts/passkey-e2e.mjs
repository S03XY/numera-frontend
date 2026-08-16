/**
 * End-to-end passkey test: real Chrome ⇄ real WebAuthn ⇄ real backend.
 *
 * The passkey flow is the one path unit tests cannot reach. Every store, browser and password
 * manager answers the PRF extension differently, and the failure that matters is a store that
 * cannot derive an account key at all. Chrome's virtual authenticator (CDP `WebAuthn` domain) is a
 * real CTAP2 implementation with a `hasPrf` switch, so all three cases can be driven for real:
 * the ceremony, the derivation, the SIWE login and the session.
 *
 * Three things are checked, and each was a way the flow could look fine and not be:
 *
 *   1. a PRF-capable store signs up and lands in a session;
 *   2. signing in again reproduces the SAME address, which is the whole promise of the design.
 *      A different one means a second, empty account and funds still on chain but off screen;
 *   3. a store that cannot derive keys fails with a message and a working way out, rather than
 *      the dead end it used to be.
 *
 * Needs the dev server and the backend running. Creates throwaway accounts in the dev database.
 *
 *   node scripts/passkey-e2e.mjs           # PRF-capable store, plus the returning-user round trip
 *   node scripts/passkey-e2e.mjs --no-prf  # a store that cannot derive, plus the recovery
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HAS_PRF = !process.argv.includes('--no-prf');
const ORIGIN = process.env.FRONTEND_URL ?? 'http://localhost:3000';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// Distinct per mode, so the two can run at once without fighting over the port.
const PORT = HAS_PRF ? 9333 : 9334;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const profile = mkdtempSync(join(tmpdir(), 'passkey-e2e-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

function cleanup() {
  chrome.kill();
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // Chrome writes to the profile as it exits, so a failed delete here is a stale temp
    // directory and nothing more.
  }
}

async function debuggerUrl() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/version`);
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

/** A virtual authenticator, described by whether it can derive keys and how it is attached. */
function authenticator(hasPrf, transport) {
  return {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport,
      hasResidentKey: true,
      hasUserVerification: true,
      hasPrf,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  };
}

async function main() {
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
  const call = (method, params) => send(ws, method, params, sessionId);

  await call('Page.enable');
  await call('Runtime.enable');
  await call('WebAuthn.enable');
  const { authenticatorId } = await call(
    'WebAuthn.addVirtualAuthenticator',
    authenticator(HAS_PRF, 'internal'),
  );
  console.log(`virtual authenticator ${authenticatorId}, hasPrf=${HAS_PRF}`);

  await call('Page.navigate', { url: ORIGIN });
  await sleep(4000);

  async function evaluate(expression) {
    const { result, exceptionDetails } = await call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.text);
    return result.value;
  }

  const click = (text, exact = true) =>
    evaluate(`(() => {
      const match = ${JSON.stringify(text)};
      const el = [...document.querySelectorAll('button')].find((b) =>
        ${exact ? 'b.textContent.trim() === match' : 'b.textContent.trim().startsWith(match)'});
      if (!el) return false;
      el.click();
      return true;
    })()`);

  /** What the header and the panel are showing right now. */
  const state = () =>
    evaluate(`(() => ({
      chip: [...document.querySelectorAll('button')]
        .map((b) => b.textContent.trim())
        .find((t) => /^0x[0-9a-fA-F]{4}/.test(t)) ?? null,
      alert: document.querySelector('[role=alert]')?.textContent.trim() ?? null,
      buttons: [...document.querySelectorAll('button')].map((b) => b.textContent.trim()),
    }))()`);

  async function step(label, action) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (await action()) {
        console.log(`  ✓ ${label}`);
        return;
      }
      await sleep(250);
    }
    console.error(`  ✗ ${label}`);
    console.error(JSON.stringify(await state(), null, 1));
    cleanup();
    process.exit(1);
  }

  /** Wait for the flow to land on either a session or a message. */
  async function settle() {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const now = await state();
      if (now.chip || now.alert) {
        // Let anything rendered alongside the message arrive before reading.
        await sleep(600);
        return state();
      }
      await sleep(500);
    }
    return state();
  }

  await step('open the sign-in panel', () => click('Enter'));
  await step('choose passkey', () => click('Use a passkey', false));
  await step('press Create account', () => click('Create account'));
  const created = await settle();
  console.log('\nafter signup:', JSON.stringify(created, null, 1));

  let returning = null;

  if (HAS_PRF && created.chip) {
    await step('reopen the chip', () => click(created.chip));
    await step('sign out', () => click('Sign out'));
    await step('open the sign-in panel again', () => click('Enter'));
    await step('choose passkey again', () => click('Use a passkey', false));
    await step('press I already have one', () => click('I already have one'));
    returning = await settle();
    console.log('\nafter signing in again:', JSON.stringify(returning, null, 1));
    console.log(
      returning.chip === created.chip
        ? `  ✓ same account reproduced: ${created.chip}`
        : `  ✗ ADDRESS CHANGED: created ${created.chip}, signed in ${returning.chip}`,
    );
  }

  // The relying party the credential actually got bound to, read off the authenticator rather than
  // off our own arguments. It is the account: a passkey bound to "localhost" is a different
  // account from one bound to the production domain, and nothing later can bridge them.
  const { credentials } = await call('WebAuthn.getCredentials', { authenticatorId });
  console.log(`\nrelying party on the authenticator: ${[
    ...new Set(credentials.map((c) => c.rpId)),
  ].join(', ')}`);
  console.log(
    `secure context: ${await evaluate('String(window.isSecureContext)')}, origin: ${await evaluate(
      'location.origin',
    )}`,
  );

  if (consoleLines.length) console.log('\npage console:\n' + consoleLines.join('\n'));

  ws.close();
  cleanup();

  // A store that cannot derive keys has to fail with an explanation and nothing else. There is no
  // button for it on purpose: where a passkey is saved is chosen in the browser's own dialog, so
  // the message points there. Asserting the absence keeps a third button from creeping back into a
  // panel whose two choices are create and sign in.
  const passed = HAS_PRF
    ? Boolean(created.chip) && returning?.chip === created.chip
    : Boolean(created.alert) &&
      /asks where to save it/i.test(created.alert) &&
      !created.buttons.some((label) => /phone or security key/i.test(label));

  console.log(`\n${passed ? 'PASS' : 'FAIL'} (hasPrf=${HAS_PRF})`);
  process.exit(passed ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  cleanup();
  process.exit(1);
});
