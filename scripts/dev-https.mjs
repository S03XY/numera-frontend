/**
 * Dev server on a real hostname over HTTPS, because passkeys need one.
 *
 * A passkey is bound to the relying party ID it was created with, and on `http://localhost:3000`
 * that ID is the literal string `localhost`. Two things follow. Platform passkey providers treat
 * it as a name they will not store a credential for, so the browser falls back to a store that
 * cannot derive account keys, which is why signup fails there and succeeds on any deployed site.
 * And a credential bound to "localhost" could never sign in to the real site anyway, so that flow
 * was never testing the thing that ships.
 *
 * This serves the app at https://local.numera.trade:3000, so the relying party is `numera.trade`:
 * the same one production uses, which makes an account created here the same account there.
 *
 * The one prerequisite needs a password and so is left to the reader:
 *
 *   echo "127.0.0.1 local.numera.trade" | sudo tee -a /etc/hosts
 *
 *   npm run dev:https
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOST = process.env.PASSKEY_DEV_HOST ?? 'local.numera.trade';
const PORT = process.env.PORT ?? '3000';
/** The registrable domain, which is what `NEXT_PUBLIC_PASSKEY_RP_ID` must be set to. */
const RP_ID = HOST.split('.').slice(-2).join('.');

const CERT = 'certificates/localhost.pem';
const KEY = 'certificates/localhost-key.pem';

function fail(...lines) {
  console.error(`\n${lines.join('\n')}\n`);
  process.exit(1);
}

function hostsEntryExists() {
  try {
    return readFileSync('/etc/hosts', 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .some((line) => /^\s*127\.0\.0\.1\s/.test(line) && line.split(/\s+/).includes(HOST));
  } catch {
    return false;
  }
}

/**
 * Read the setting from where Next reads it.
 *
 * `NEXT_PUBLIC_PASSKEY_RP_ID` lives in `.env.local`, which Next loads and this process does not,
 * so checking `process.env` alone would always find nothing and pass. That is the one mismatch
 * worth catching here: a wrong relying party is refused by the browser as a bare `SecurityError`,
 * or derives an account nothing else can reach.
 */
function configuredRpId() {
  const fromShell = process.env.NEXT_PUBLIC_PASSKEY_RP_ID?.trim();
  if (fromShell) return fromShell;
  try {
    const match = readFileSync('.env.local', 'utf8').match(
      /^\s*NEXT_PUBLIC_PASSKEY_RP_ID\s*=\s*(.*)$/m,
    );
    return match?.[1].trim().replace(/^["']|["']$/g, '') || undefined;
  } catch {
    return undefined;
  }
}

/** mkcert, wherever it is. Next caches a copy, which is reused rather than downloaded again. */
function mkcertPath() {
  const cached = join(homedir(), 'Library/Caches/mkcert');
  try {
    const entries = execFileSync('ls', [cached], { encoding: 'utf8' }).split('\n');
    const found = entries.find((name) => name.startsWith('mkcert-'));
    if (found) return join(cached, found);
  } catch {
    // No cached copy. Fall through to one on PATH.
  }
  try {
    return execFileSync('which', ['mkcert'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * A certificate the browser accepts, without asking for a password.
 *
 * `next dev --experimental-https` runs `mkcert -install`, which writes to the system trust store
 * and needs sudo. When that fails Next prints one line and falls back to plain http, where
 * passkeys break for an unrelated reason with an error that never mentions certificates. Trusting
 * the authority in the login keychain instead reaches the same browsers and needs no password, so
 * the failure mode disappears rather than being reported better.
 */
function ensureCertificate() {
  const mkcert = mkcertPath();
  if (!mkcert) {
    fail(
      'mkcert was not found. Install it once:',
      '',
      '  brew install mkcert',
    );
  }

  if (!existsSync(CERT) || !existsSync(KEY)) {
    console.log(`Issuing a certificate for ${HOST}...`);
    execFileSync(mkcert, ['-cert-file', CERT, '-key-file', KEY, HOST, 'localhost', '127.0.0.1'], {
      stdio: 'inherit',
    });
  }

  try {
    execFileSync('security', ['verify-cert', '-c', CERT], { stdio: 'ignore' });
    return;
  } catch {
    // Not trusted yet.
  }

  const caRoot = execFileSync(mkcert, ['-CAROOT'], { encoding: 'utf8' }).trim();
  console.log('Trusting the local certificate authority for this user...');
  try {
    execFileSync(
      'security',
      [
        'add-trusted-cert',
        '-r',
        'trustRoot',
        '-k',
        join(homedir(), 'Library/Keychains/login.keychain-db'),
        join(caRoot, 'rootCA.pem'),
      ],
      { stdio: 'inherit' },
    );
  } catch {
    fail(
      'Could not add the certificate authority to your login keychain. Run this once:',
      '',
      `  "${mkcert}" -install`,
    );
  }
}

if (!hostsEntryExists()) {
  fail(
    `${HOST} does not resolve to this machine yet. Add it once:`,
    '',
    `  echo "127.0.0.1 ${HOST}" | sudo tee -a /etc/hosts`,
  );
}

const rpId = configuredRpId();
if (!rpId) {
  fail(
    `NEXT_PUBLIC_PASSKEY_RP_ID is not set, so passkeys would bind to "${HOST}" rather than`,
    `"${RP_ID}" and an account made here would not exist in production.`,
    '',
    `  frontend/.env.local   NEXT_PUBLIC_PASSKEY_RP_ID=${RP_ID}`,
  );
}
if (rpId !== RP_ID) {
  fail(`NEXT_PUBLIC_PASSKEY_RP_ID is "${rpId}" but this host needs "${RP_ID}".`);
}

ensureCertificate();

console.log(`\nServing https://${HOST}:${PORT}`);
console.log(`Passkeys bind to ${RP_ID}, the same relying party production uses.`);
console.log(`The backend's CORS_ORIGINS must include https://${HOST}:${PORT}.\n`);

// Explicit paths rather than letting Next generate: its own path needs sudo, and its fallback on
// failure is plain http, which serves the app fine and breaks the one thing this script exists for.
const next = spawn(
  'npx',
  [
    'next',
    'dev',
    '--experimental-https',
    '--experimental-https-key',
    KEY,
    '--experimental-https-cert',
    CERT,
    '-H',
    HOST,
    '-p',
    String(PORT),
  ],
  { stdio: 'inherit' },
);
next.on('exit', (code) => process.exit(code ?? 0));
