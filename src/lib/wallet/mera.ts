import {
  createSecp256k1SigningSession,
  getEvmAddress,
  getPasskeyPrfOutput,
} from '@category-labs/mera';
import { toViemAccount } from '@category-labs/mera/viem';
import { HDKey } from '@scure/bip32';
import { entropyToMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { toWalletError, WalletError, type WalletSigner } from './types';

/**
 * Mera passkey wallet.
 *
 * A passkey's WebAuthn PRF output (32 deterministic secret bytes) is used as
 * BIP-39 entropy, then HD-derived to a standard secp256k1 EOA. Because the
 * derivation is deterministic, the SAME passkey reproduces the SAME address on
 * every device — which is why a returning user on a new phone lands on their
 * existing account with no seed phrase and no server-side recovery.
 *
 * This mirrors Mera's own reference derivation (their demo `hd.ts`), so the
 * resulting mnemonic also imports cleanly into a standard wallet like MetaMask.
 */

const RP_NAME = 'Numera';
const EVM_PATH = "m/44'/60'/0'/0/0";

export function isPasskeySupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    !!navigator.credentials
  );
}

/**
 * A passkey alone is not enough — we need one whose store supports **PRF**.
 *
 * PRF is what makes the whole design work: it gives us 32 deterministic secret
 * bytes per credential, which become the seed. Without it a passkey can prove
 * who you are but cannot derive a key, so there is no account to sign in to.
 *
 * Support is uneven, not something a user can be expected to know, and the
 * intuitive answer is backwards. On desktop Chrome the browser's own profile
 * store cannot derive a key, having no `hmac-secret`, while iCloud Keychain can
 * from Chrome 132 on macOS 15 and up.
 *
 * `getClientCapabilities` is recent, so `null` means "cannot tell" — never
 * "unsupported". We use it only to warn *before* a ceremony that would leave a
 * useless credential behind in the user's password manager; the authoritative
 * answer still comes from the ceremony itself.
 */
export async function prfCapability(): Promise<boolean | null> {
  const api = (
    window as unknown as {
      PublicKeyCredential?: { getClientCapabilities?: () => Promise<Record<string, boolean>> };
    }
  ).PublicKeyCredential;

  if (typeof api?.getClientCapabilities !== 'function') return null;
  try {
    const capabilities = await api.getClientCapabilities();
    const prf = capabilities['extension:prf'];
    return typeof prf === 'boolean' ? prf : null;
  } catch {
    return null;
  }
}

/**
 * A dismissed prompt, however deeply it is wrapped.
 *
 * Mera boxes every WebAuthn throw into a `MeraError` and hangs the original on `cause`, so the
 * `NotAllowedError` that means "the user closed the dialog" arrives with the name `MeraError` and
 * the message "Passkey assertion failed". Read only at the top, a cancellation becomes a red error
 * panel telling somebody their passkey is broken because they changed their mind.
 */
function isCancellation(err: unknown): boolean {
  for (let cursor: unknown = err, depth = 0; cursor && depth < 4; depth += 1) {
    const name = (cursor as { name?: string }).name;
    if (name === 'NotAllowedError' || name === 'AbortError') return true;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Turn Mera's `PRF_UNAVAILABLE` into something a user can act on, on the sign-in path.
 *
 * The raw messages ("Authenticator did not return PRF output", "PRF output must be 32 bytes") are
 * accurate and completely unactionable. Signing in is also the one path where the advice cannot be
 * about where to save it: the passkey already exists, so the only moves left are pick a different
 * one, make a new account, or use MetaMask.
 *
 * The reason is appended rather than swallowed, because the three failures Mera folds into this
 * one code are diagnosable apart and we would otherwise be guessing which happened.
 */
function toPasskeyError(err: unknown): WalletError {
  // Ours already, and already written for a reader. Rewriting it would append the reason to a
  // message that IS the reason.
  if (err instanceof WalletError) return err;
  if (isCancellation(err)) {
    return new WalletError('CANCELLED', 'Request cancelled.', { cause: err });
  }

  if ((err as { code?: string })?.code !== 'PRF_UNAVAILABLE') {
    return toWalletError(err, 'DERIVATION_FAILED');
  }

  const reason = (err as { message?: string })?.message ?? '';
  return new WalletError(
    'PRF_UNAVAILABLE',
    `That passkey cannot derive an account key. Where a passkey is saved decides this, and a ` +
      `password manager that offered to save it may not be able to. ${PRF_STORES} Every failed ` +
      `attempt also leaves a passkey behind that will keep being offered here, so delete those. ` +
      `Then create an account, saving the passkey to one of those, or sign in with MetaMask. ` +
      `(Reason: ${reason})`,
    { cause: err },
  );
}

/**
 * The relying party a passkey account belongs to.
 *
 * A credential is bound to this string permanently and the derived account key is scoped to it,
 * so it decides which origins can ever reach the account again. Two consequences, both money.
 *
 * **It should be the registrable domain, not the host.** Left as `location.hostname`, an account
 * created on `app.numera.trade` cannot be reached from `numera.trade`, and moving the app to a
 * different subdomain later orphans every account made before the move, funds still on chain and
 * no ceremony able to derive the key again. WebAuthn accepts any registrable-domain suffix of the
 * page's host, so naming the domain once covers every subdomain forever.
 *
 * **It should be a real domain in development.** On `http://localhost:3000` this returns the
 * literal `localhost`, so a passkey created while developing is bound to "localhost" and is
 * useless on the deployed site by construction, which means that flow never tested what ships.
 * See `npm run dev:https`.
 *
 * That second point is worth stating carefully, because it was once offered as the explanation for
 * a signup failure and was not: the cause turned out to be the passkey store, which cannot derive
 * keys on any origin. Both facts are real and only one of them was the bug.
 */
export function passkeyRpId(): string {
  const host = window.location.hostname;
  const configured = process.env.NEXT_PUBLIC_PASSKEY_RP_ID?.trim();
  if (!configured) return host;

  // WebAuthn requires rp.id to equal the page's host or be a registrable-domain suffix of it, and
  // a browser that disagrees throws a bare `SecurityError` naming neither value. Checked here so a
  // misconfigured deployment says which two strings failed to match rather than reading as a
  // broken passkey.
  if (host !== configured && !host.endsWith(`.${configured}`)) {
    throw new WalletError(
      'UNSUPPORTED',
      `Passkeys here are set up for ${configured}, but this page is on ${host}. ` +
        `Sign in with MetaMask, or serve the app under ${configured}.`,
    );
  }
  return configured;
}

/**
 * Which passkey stores can hold an account key.
 *
 * Every name here is a row in Mera's support matrix, and every row there is a confirmed live PRF
 * create and get cycle rather than a reading of anyone's release notes.
 *
 * Only what works is named, and the omission is deliberate. A list of stores that failed is a
 * claim with a shelf life: Bitwarden and Dashlane returned no PRF when the matrix was last run and
 * both are building on the extension, so naming them rots into a falsehood rather than merely
 * going stale, and it is a falsehood about somebody else's product. Nothing gates on it either,
 * because signup now asks the authenticator instead of predicting the answer, so a store that has
 * since gained support simply works and never reaches this sentence. What a reader needs at this
 * moment is somewhere to go, which the positives already give.
 *
 * Two details the list has to keep. **Windows Hello** belongs in it because it carries PRF on
 * Windows 11 25H2 and up and is the default there; left out, a Windows user reads this as though
 * nothing on their machine works. And **most** security keys rather than all, because PRF needs
 * `hmac-secret`, which is YubiKey 5.2 and up.
 *
 * @see https://mera.category.xyz/authenticator-support/
 */
const PRF_STORES =
  'iCloud Keychain, Google Password Manager (sign in to Chrome), Windows Hello, 1Password, ' +
  'Proton Pass and most security keys work.';

/**
 * PRF output -> BIP-39 mnemonic -> seed -> account key.
 * Secrets are zeroed as soon as they are consumed; only the signing session
 * (which holds the key in memory and can be ended) survives.
 */
function signerFromPrf(prfOutput: Uint8Array): WalletSigner {
  let seed: Uint8Array | null = null;
  try {
    seed = mnemonicToSeedSync(entropyToMnemonic(prfOutput, wordlist));
    const node = HDKey.fromMasterSeed(seed).derive(EVM_PATH);
    if (!node.privateKey) {
      throw new WalletError('DERIVATION_FAILED', 'BIP-32 derivation produced no private key');
    }

    const session = createSecp256k1SigningSession({ privateKey: node.privateKey });
    const account = toViemAccount(session);

    return {
      address: getEvmAddress(session.publicKey),
      kind: 'passkey',
      // Exposed for the shielded-pool deposit flow, which needs EIP-712 signing
      // and a real approval transaction. Signing through it never prompts the
      // passkey again — the session already holds the key.
      evmAccount: account,
      async signMessage(message: string) {
        try {
          return await account.signMessage({ message });
        } catch (err) {
          throw toWalletError(err, 'SIGN_FAILED');
        }
      },
      disconnect() {
        session.end(); // zeroes the in-memory private key
      },
    };
  } finally {
    prfOutput.fill(0);
    seed?.fill(0);
  }
}

/** Where the browser should try to put the new passkey. */
export type PasskeyStore =
  /** Wherever this browser saves passkeys by default. */
  | 'default'
  /** A phone or a security key, reached over WebAuthn's cross-device flow. */
  | 'cross-device';

/** The salt Mera evaluates, `sha256("mera.prf.salt.v1")`. Same input, so the same account key. */
async function prfSalt(): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode('mera.prf.salt.v1'),
  );
  return new Uint8Array(digest);
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

/** Canonical base64url, which is the form Mera validates credential IDs against. */
function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Normalise create-time PRF output, or report that there is none.
 *
 * Authenticators disagree on the shape: most return an `ArrayBuffer`, some a view, and the
 * 1Password extension a plain array of byte values. Anything that is not exactly 32 bytes is
 * treated as absent rather than repaired, because the next step is to ask again properly and a
 * short buffer stretched into key material would derive a wrong, silently valid account.
 */
function toPrfBytes(value: unknown): Uint8Array | null {
  let bytes: Uint8Array | null = null;

  if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value.slice(0));
  } else if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    bytes = new Uint8Array(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength).slice();
  } else if (Array.isArray(value)) {
    if (!value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) return null;
    bytes = Uint8Array.from(value);
  }

  return bytes?.length === 32 ? bytes : null;
}

type PrfExtensionResults = {
  prf?: { enabled?: boolean; results?: { first?: unknown } };
};

/** Both ceremonies asked for a key and neither produced one. */
function noKeyFromPasskey(store: PasskeyStore, cause: unknown): WalletError {
  const advice =
    store === 'cross-device'
      ? 'That phone or security key cannot derive one either. A phone needs iOS 18 or Android 14 ' +
        'with a recent browser. You can sign in with MetaMask instead.'
      : `Where a passkey is saved decides this, and your browser saved it somewhere that cannot. ` +
        `${PRF_STORES} Choose one of those, or a phone, when your browser asks where to save it. ` +
        `You can also sign in with MetaMask.`;

  return new WalletError(
    'PRF_UNAVAILABLE',
    `We asked twice and got no account key back. ${advice} The passkey just created will never ` +
      `work, so delete it.`,
    { cause },
  );
}

/**
 * Create a brand-new passkey account (first-time signup).
 *
 * ## Why this runs the ceremony itself instead of calling Mera's `createPasskeyWithPrfOutput`
 *
 * Mera reads `prf.enabled` from the creation result and throws `PRF_UNAVAILABLE` the moment it is
 * false, before it tries anything. That flag is the browser's *prediction*, and it is reported by
 * the client rather than measured: a store that evaluates PRF only during an assertion, a
 * password-manager extension that relays the ceremony, or a browser that has not learned the
 * provider's capabilities can all answer false and then hand back a perfectly good PRF output when
 * actually asked. Refusing on the prediction turned every one of those into a dead end with no
 * retry, which is exactly the failure this signup was reported to have.
 *
 * So the flag is ignored and the question is settled by asking. The cost of being wrong is
 * asymmetric and that is the whole argument: attempting an assertion that fails costs one extra
 * prompt and yields a definite answer, while refusing an assertion that would have worked costs
 * the account entirely.
 *
 * Mera still owns the second ceremony, the salt, and the derivation, so the account key here is
 * bit-for-bit the one {@link connectPasskeyWallet} reproduces on any other device.
 *
 * ## What `store` is for
 *
 * Which provider a browser hands a passkey to is decided by its own settings and by whichever
 * extension intercepted the dialog, and no API steers between two platform providers. WebAuthn's
 * `hints` do steer *off* the platform, though, and that is the escape hatch: a phone or a security
 * key is a different authenticator, and both support PRF on current versions. It is the one real
 * move left for somebody whose browser keeps saving to a store that cannot derive keys.
 */
export async function createPasskeyWallet(
  label = 'Numera account',
  store: PasskeyStore = 'default',
): Promise<WalletSigner> {
  if (!isPasskeySupported()) {
    throw new WalletError('UNSUPPORTED', 'Passkeys are not supported in this browser.');
  }

  const salt = await prfSalt();
  let credential: PublicKeyCredential | null;

  try {
    // `hints` is WebAuthn L3 and newer than the DOM types here. Browsers that predate it ignore
    // unknown members, and `authenticatorAttachment` carries the same intent to those that do.
    const publicKey: PublicKeyCredentialCreationOptions & { hints?: string[] } = {
      rp: { id: passkeyRpId(), name: RP_NAME },
      user: {
        id: randomBytes(32) as unknown as BufferSource,
        name: label,
        displayName: label,
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
        ...(store === 'cross-device' ? { authenticatorAttachment: 'cross-platform' as const } : {}),
      },
      ...(store === 'cross-device' ? { hints: ['hybrid', 'security-key'] } : {}),
      extensions: {
        prf: { eval: { first: salt as unknown as BufferSource } },
      } as AuthenticationExtensionsClientInputs,
    };

    credential = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null;
  } catch (err) {
    throw toPasskeyError(err);
  }

  if (!credential) throw new WalletError('CANCELLED', 'Request cancelled.');

  const prf = (credential.getClientExtensionResults() as PrfExtensionResults).prf;

  // The good case, and the quiet one: the authenticator evaluated the salt during creation, so
  // there is a key already and the user saw a single prompt.
  const evaluated = toPrfBytes(prf?.results?.first);
  if (evaluated) return signerFromPrf(evaluated);

  const response = credential.response as AuthenticatorAttestationResponse;
  const transports =
    typeof response.getTransports === 'function' ? response.getTransports() : undefined;

  try {
    const { prfOutput } = await getPasskeyPrfOutput({
      rpId: passkeyRpId(),
      // Pinned to the credential just made. Left open, the assertion would accept any passkey for
      // this site, and a returning user would silently sign in to an older account while looking
      // at a dialog that says they are creating one.
      credential: {
        credentialId: toBase64Url(new Uint8Array(credential.rawId)),
        ...(transports?.length ? { transports: [...transports] } : {}),
      },
      prfSalt: salt,
    });
    return signerFromPrf(prfOutput);
  } catch (err) {
    if (isCancellation(err)) throw new WalletError('CANCELLED', 'Request cancelled.', { cause: err });
    throw noKeyFromPasskey(store, err);
  }
}

/** Sign in with an existing passkey (returning user, any device). */
export async function connectPasskeyWallet(): Promise<WalletSigner> {
  if (!isPasskeySupported()) {
    throw new WalletError('UNSUPPORTED', 'Passkeys are not supported in this browser.');
  }
  try {
    const { prfOutput } = await getPasskeyPrfOutput({ rpId: passkeyRpId() });
    return signerFromPrf(prfOutput);
  } catch (err) {
    throw toPasskeyError(err);
  }
}
