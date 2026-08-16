'use client';

import * as React from 'react';
import { Button } from '@/components/ui/Button';
import { Folio, Plate, SectionHead } from '@/components/ui/primitives';
import { Footer, Header } from '@/components/layout/Header';
import { passkeyRpId } from '@/lib/wallet/mera';

/**
 * TEMPORARY — delete `src/app/passkey-check/` once the PRF question is settled.
 *
 * Why this exists: `PRF_UNAVAILABLE` is thrown for three different reasons and the sign-in panel
 * shows one sentence for all of them, which guesses at the cause ("your passkey store cannot
 * derive a key") and is only sometimes right. This runs the same ceremonies the real flow runs and
 * prints what the authenticator actually answered, so the cause is read rather than inferred.
 *
 * Deliberately raw WebAuthn rather than a call into `lib/wallet/mera.ts`: the point is to see the
 * layer underneath, including the cases Mera folds into one error code.
 */

const PRF_SALT_LABEL = 'mera.prf.salt.v1';

/** The salt Mera evaluates: sha256("mera.prf.salt.v1"). Same input, so the same PRF output. */
async function meraSalt(): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(PRF_SALT_LABEL));
}

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** Whatever shape the authenticator returned PRF output in, described rather than decoded. */
function describePrfOutput(value: unknown): string {
  if (value === undefined || value === null) return 'absent';
  if (value instanceof ArrayBuffer) return `ArrayBuffer, ${value.byteLength} bytes`;
  if (ArrayBuffer.isView(value)) {
    return `${value.constructor.name}, ${(value as ArrayBufferView).byteLength} bytes`;
  }
  if (Array.isArray(value)) return `plain array, ${value.length} entries`;
  return `unexpected type: ${typeof value}`;
}

type Line = { label: string; value: string; tone?: 'ok' | 'bad' | 'warn' };

export default function PasskeyCheckPage() {
  const [lines, setLines] = React.useState<Line[]>([]);
  const [running, setRunning] = React.useState(false);

  const push = (line: Line) => setLines((prev) => [...prev, line]);

  async function environment() {
    push({ label: 'User agent', value: navigator.userAgent });
    push({
      label: 'Secure context',
      value: String(window.isSecureContext),
      tone: window.isSecureContext ? 'ok' : 'bad',
    });
    push({ label: 'Origin', value: window.location.origin });
    push({ label: 'Page host', value: window.location.hostname });
    // The relying party the real flow uses, which is configurable and is often NOT the host. Read
    // from the same helper rather than re-derived: this page measured the hostname while the app
    // used the configured domain, so it was describing a ceremony nobody runs.
    push({ label: 'RP ID the app uses', value: passkeyRpId() });

    const pkc = window.PublicKeyCredential as unknown as {
      getClientCapabilities?: () => Promise<Record<string, boolean>>;
      isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean>;
    };

    if (typeof pkc?.isUserVerifyingPlatformAuthenticatorAvailable === 'function') {
      const available = await pkc.isUserVerifyingPlatformAuthenticatorAvailable().catch(() => null);
      push({ label: 'Platform authenticator', value: String(available) });
    }

    if (typeof pkc?.getClientCapabilities === 'function') {
      const caps = await pkc.getClientCapabilities().catch(() => null);
      // This reports what the BROWSER supports, not what the chosen passkey provider supports —
      // which is exactly why it cannot be used as a pre-flight gate.
      push({
        label: 'Browser: extension:prf',
        value: caps ? String(caps['extension:prf']) : 'getClientCapabilities threw',
        tone: caps?.['extension:prf'] ? 'ok' : 'warn',
      });
      push({ label: 'All client capabilities', value: caps ? JSON.stringify(caps) : '—' });
    } else {
      push({ label: 'Browser: extension:prf', value: 'getClientCapabilities unsupported', tone: 'warn' });
    }
  }

  /** The create ceremony, with exactly the parameters Mera uses. */
  async function create() {
    push({ label: '— create() —', value: 'a passkey prompt is about to appear' });
    const salt = await meraSalt();

    const credential = (await navigator.credentials.create({
      publicKey: {
        rp: { id: passkeyRpId(), name: 'Numera' },
        user: {
          id: randomBytes(32) as unknown as BufferSource,
          name: 'Numera diagnostic',
          displayName: 'Numera diagnostic',
        },
        challenge: randomBytes(32) as unknown as BufferSource,
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        attestation: 'none',
        authenticatorSelection: {
          residentKey: 'required',
          requireResidentKey: true,
          userVerification: 'required',
        },
        extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;

    if (!credential) {
      push({ label: 'create()', value: 'returned null', tone: 'bad' });
      return null;
    }

    const results = credential.getClientExtensionResults() as {
      prf?: { enabled?: boolean; results?: { first?: unknown } };
    };
    const prf = results.prf;

    push({ label: 'create(): extension results', value: JSON.stringify(Object.keys(results)) });
    push({
      label: 'create(): prf.enabled',
      value: String(prf?.enabled),
      // THE line that decides everything. `false` here is the authenticator saying it cannot do
      // PRF for this credential at all — no retry, no fallback, the passkey is unusable to us.
      tone: prf?.enabled ? 'ok' : 'bad',
    });
    push({
      label: 'create(): prf.results.first',
      value: describePrfOutput(prf?.results?.first),
      // Absent here is NORMAL and not fatal: many authenticators only evaluate PRF during an
      // assertion, which is why the fallback get() below exists.
      tone: prf?.results?.first ? 'ok' : 'warn',
    });

    const response = credential.response as AuthenticatorAttestationResponse;
    if (typeof response.getTransports === 'function') {
      push({ label: 'create(): transports', value: JSON.stringify(response.getTransports()) });
    }
    return credential;
  }

  /** The fallback assertion — the second half of Mera's create path. */
  async function assert(credential: PublicKeyCredential | null) {
    push({ label: '— get() —', value: 'a second passkey prompt is about to appear' });
    const salt = await meraSalt();

    const assertion = (await navigator.credentials.get({
      publicKey: {
        rpId: passkeyRpId(),
        challenge: randomBytes(32) as unknown as BufferSource,
        userVerification: 'required',
        ...(credential
          ? { allowCredentials: [{ id: credential.rawId, type: 'public-key' as const }] }
          : {}),
        extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;

    if (!assertion) {
      push({ label: 'get()', value: 'returned null', tone: 'bad' });
      return;
    }

    const prf = (
      assertion.getClientExtensionResults() as {
        prf?: { enabled?: boolean; results?: { first?: unknown } };
      }
    ).prf;

    push({ label: 'get(): prf.enabled', value: String(prf?.enabled) });
    push({
      label: 'get(): prf.results.first',
      value: describePrfOutput(prf?.results?.first),
      // This is the one that has to work. Mera derives the account key from exactly this.
      tone: prf?.results?.first ? 'ok' : 'bad',
    });
  }

  async function run() {
    setLines([]);
    setRunning(true);
    try {
      await environment();
      let credential: PublicKeyCredential | null = null;
      try {
        credential = await create();
      } catch (err) {
        push({
          label: 'create() threw',
          value: `${(err as Error)?.name}: ${(err as Error)?.message}`,
          tone: 'bad',
        });
      }
      try {
        await assert(credential);
      } catch (err) {
        push({
          label: 'get() threw',
          value: `${(err as Error)?.name}: ${(err as Error)?.message}`,
          tone: 'bad',
        });
      }
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <Header />
      <main className="flex-1">
        <section className="shell py-10 sm:py-14">
          <header className="mb-8">
            <h1 className="h-sec">Passkey PRF check</h1>
            <p className="mt-2.5 max-w-[70ch] text-[14px] leading-relaxed text-ink-dim">
              Runs the same two WebAuthn ceremonies the sign-in flow runs, and prints what your
              authenticator actually answered. It creates one throwaway passkey — delete it
              afterwards. Nothing is sent anywhere and no account is created.
            </p>
            <p className="mt-2 max-w-[70ch] text-[13px] leading-relaxed text-ink-mute">
              You will see two prompts. Pick the <strong>same</strong> place to save the passkey
              that failed for you before, or the result will not describe your problem.
            </p>
          </header>

          <Button variant="primary" size="lg" onClick={() => void run()} disabled={running}>
            {running ? 'Running…' : 'Run the check'}
          </Button>

          {lines.length > 0 && (
            <Plate className="mt-6 p-4 sm:p-5">
              <SectionHead>Result</SectionHead>
              <dl className="mt-3.5 space-y-2">
                {lines.map((line, i) => (
                  <div key={i} className="flex flex-col gap-0.5 border-b border-line pb-2 last:border-0">
                    <dt className="folio">{line.label}</dt>
                    <dd
                      className={
                        'mono min-w-0 break-all text-[11.5px] ' +
                        (line.tone === 'ok'
                          ? 'text-pos'
                          : line.tone === 'bad'
                            ? 'text-neg'
                            : line.tone === 'warn'
                              ? 'text-accent-bright'
                              : 'text-ink-dim')
                      }
                    >
                      {line.value}
                    </dd>
                  </div>
                ))}
              </dl>
              <Folio className="mt-4 block">
                Copy this whole panel when reporting the result.
              </Folio>
            </Plate>
          )}
        </section>
      </main>
      <Footer />
    </>
  );
}
