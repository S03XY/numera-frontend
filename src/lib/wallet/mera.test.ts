import { createHash, webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getPasskeyPrfOutput = vi.fn();

vi.mock('@category-labs/mera', () => ({
  getPasskeyPrfOutput,
  createSecp256k1SigningSession: vi.fn(() => ({
    publicKey: new Uint8Array(33),
    end: vi.fn(),
  })),
  getEvmAddress: vi.fn(() => '0xabc'),
}));
vi.mock('@category-labs/mera/viem', () => ({
  toViemAccount: vi.fn(() => ({ signMessage: vi.fn() })),
}));

const { connectPasskeyWallet, createPasskeyWallet, prfCapability } = await import('./mera');

/** Mera's shape for a failure: a thrown object carrying a string `code`. */
function meraError(message: string, code = 'PRF_UNAVAILABLE', cause?: unknown) {
  return Object.assign(new Error(message), { name: 'MeraError', code, cause });
}

const cancelled = Object.assign(new Error('The operation was aborted.'), {
  name: 'NotAllowedError',
});

/** A create() result, described by what its PRF extension answered. */
function credential(prf: unknown, rawId = Uint8Array.from([1, 2, 3, 4])) {
  return {
    type: 'public-key',
    rawId: rawId.buffer.slice(rawId.byteOffset, rawId.byteOffset + rawId.byteLength),
    response: { getTransports: () => ['internal'] },
    getClientExtensionResults: () => ({ prf }),
  };
}

const create = vi.fn();
const get = vi.fn();

/** The 32 bytes any store that works hands back. */
const KEY_MATERIAL = new Uint8Array(32).fill(7);

function setCapabilities(value: unknown) {
  (window as unknown as { PublicKeyCredential: unknown }).PublicKeyCredential = {
    getClientCapabilities: value,
  };
}

/** The options the last create() ceremony was built with. */
function creationOptions() {
  return create.mock.calls[0]?.[0]?.publicKey as PublicKeyCredentialCreationOptions & {
    hints?: string[];
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setCapabilities(undefined);
  // jsdom ships no credentials API, so `isPasskeySupported()` would short-circuit
  // to UNSUPPORTED and these tests would never reach the code under test.
  Object.defineProperty(navigator, 'credentials', {
    value: { create, get },
    configurable: true,
  });
  // jsdom's Crypto has getRandomValues but no subtle, and the PRF salt is a SHA-256 of a fixed
  // label. Without this every create ceremony here would throw before reaching the authenticator.
  if (!globalThis.crypto.subtle) {
    Object.defineProperty(globalThis.crypto, 'subtle', {
      value: webcrypto.subtle,
      configurable: true,
    });
  }
});

afterEach(() => {
  delete (window as unknown as { PublicKeyCredential?: unknown }).PublicKeyCredential;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/*
  The relying party ID, which is the account.

  A passkey is bound to this string permanently and the derived key is scoped to it, so it decides
  which origins can reach the account ever again. It was `location.hostname`, which is wrong in two
  directions at once: it binds an account to one exact subdomain, and in development it produces
  the literal "localhost", a name platform passkey providers will not store a credential for. The
  second is why signup failed here while Mera's own demo, running the identical ceremony on a real
  domain, worked.
*/
describe('the relying party a passkey belongs to', () => {
  const rpOf = () => (create.mock.calls[0][0].publicKey as PublicKeyCredentialCreationOptions).rp.id;

  beforeEach(() => {
    create.mockResolvedValue(credential({ enabled: false }));
    getPasskeyPrfOutput.mockResolvedValue({ credentialId: 'AQIDBA', prfOutput: KEY_MATERIAL });
  });

  it('falls back to the page host when nothing is configured (positive)', async () => {
    await createPasskeyWallet();
    expect(rpOf()).toBe('localhost');
  });

  it('uses the configured domain from a subdomain (MONEY REGRESSION)', async () => {
    vi.stubEnv('NEXT_PUBLIC_PASSKEY_RP_ID', 'numera.trade');
    vi.stubGlobal('location', { hostname: 'app.numera.trade' });

    await createPasskeyWallet();

    // Bound to the host instead, an account made on app.numera.trade is unreachable from
    // numera.trade, and moving the app to another subdomain later orphans every account created
    // before the move, funds still on chain and no ceremony able to derive the key again.
    expect(rpOf()).toBe('numera.trade');
  });

  it('signs in against the same relying party it created (MONEY REGRESSION)', async () => {
    vi.stubEnv('NEXT_PUBLIC_PASSKEY_RP_ID', 'numera.trade');
    vi.stubGlobal('location', { hostname: 'app.numera.trade' });

    await connectPasskeyWallet();

    // Two paths, one string. If they ever disagree, signing in derives a different account than
    // signing up did, silently, and both are valid.
    expect(getPasskeyPrfOutput.mock.calls[0][0].rpId).toBe('numera.trade');
  });

  it('names both strings when the page is served from somewhere else (negative)', async () => {
    vi.stubEnv('NEXT_PUBLIC_PASSKEY_RP_ID', 'numera.trade');
    vi.stubGlobal('location', { hostname: 'staging.example.com' });

    // The browser refuses this with a bare `SecurityError` naming neither value, which reads as a
    // broken passkey rather than a wrong setting.
    const error: unknown = await createPasskeyWallet().catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/numera\.trade/);
    expect((error as Error).message).toMatch(/staging\.example\.com/);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('prfCapability', () => {
  it('reports support when the browser says so (positive)', async () => {
    setCapabilities(async () => ({ 'extension:prf': true }));
    await expect(prfCapability()).resolves.toBe(true);
  });

  it('reports absence when the browser says so (positive)', async () => {
    setCapabilities(async () => ({ 'extension:prf': false }));
    await expect(prfCapability()).resolves.toBe(false);
  });

  it('answers "cannot tell" on browsers without the API (negative)', async () => {
    // Distinct from `false` on purpose: warning every user of an older browser
    // that passkeys will not work — when they usually do — is worse than silence.
    setCapabilities(undefined);
    await expect(prfCapability()).resolves.toBeNull();
  });

  it('answers "cannot tell" when the key is missing from the result (negative)', async () => {
    setCapabilities(async () => ({ 'extension:largeBlob': true }));
    await expect(prfCapability()).resolves.toBeNull();
  });

  it('never throws when the capability probe itself fails (regression)', async () => {
    // This runs while the sign-in panel is open; a rejection here would take
    // down the whole door rather than one hint inside it.
    setCapabilities(async () => {
      throw new Error('not implemented');
    });
    await expect(prfCapability()).resolves.toBeNull();
  });
});

/*
  `prf.enabled` is a prediction, and signup used to treat it as a verdict.

  Mera reads the flag off the creation result and throws before trying anything. The flag is
  reported by the browser, not measured: a store that evaluates PRF only during an assertion, an
  extension relaying the ceremony, or a browser that has not learned the provider's capabilities
  can each answer false and then produce a perfectly good 32 bytes when actually asked. Every one
  of those users hit a dead end reading "your passkey store cannot hold an account key", which was
  a guess, and had no retry.

  These are the tests for asking instead of guessing.
*/
describe('creating a passkey account', () => {
  it('asks anyway when the authenticator says PRF is off (MONEY REGRESSION)', async () => {
    create.mockResolvedValue(credential({ enabled: false }));
    getPasskeyPrfOutput.mockResolvedValue({ credentialId: 'AQIDBA', prfOutput: KEY_MATERIAL });

    await expect(createPasskeyWallet()).resolves.toMatchObject({
      address: '0xabc',
      kind: 'passkey',
    });
    expect(getPasskeyPrfOutput).toHaveBeenCalledTimes(1);
  });

  it('uses the create-time output without a second prompt (positive)', async () => {
    create.mockResolvedValue(
      credential({ enabled: true, results: { first: KEY_MATERIAL.buffer } }),
    );

    await expect(createPasskeyWallet()).resolves.toMatchObject({ kind: 'passkey' });
    // One ceremony, one prompt. Asking again when the answer is already in hand turns the common
    // case into two dialogs seconds apart, which reads as a stuck screen.
    expect(getPasskeyPrfOutput).not.toHaveBeenCalled();
  });

  it('evaluates Mera’s own salt, so the account is reproducible (MONEY REGRESSION)', async () => {
    create.mockResolvedValue(credential({ enabled: false }));
    getPasskeyPrfOutput.mockResolvedValue({ credentialId: 'AQIDBA', prfOutput: KEY_MATERIAL });

    await createPasskeyWallet();

    // The salt IS the account. Signing in later goes through Mera's own default, so a different
    // salt here would create an account that no returning sign-in can ever reach again: valid,
    // funded, and unreachable.
    const expected = new Uint8Array(createHash('sha256').update('mera.prf.salt.v1').digest());
    expect(getPasskeyPrfOutput.mock.calls[0][0].prfSalt).toEqual(expected);
    const salt = creationOptions().extensions as { prf: { eval: { first: Uint8Array } } };
    expect(new Uint8Array(salt.prf.eval.first)).toEqual(expected);
  });

  it('pins the assertion to the passkey just created (MONEY REGRESSION)', async () => {
    create.mockResolvedValue(credential({ enabled: false }));
    getPasskeyPrfOutput.mockResolvedValue({ credentialId: 'AQIDBA', prfOutput: KEY_MATERIAL });

    await createPasskeyWallet();

    // Left open, the assertion accepts any passkey for this site. A returning user pressing
    // "Create account" would then be signed into an older account while looking at a dialog that
    // says they are making a new one, and the new passkey would be orphaned.
    expect(getPasskeyPrfOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        credential: expect.objectContaining({ credentialId: 'AQIDBA' }),
      }),
    );
  });

  it('ignores create-time output that is not 32 bytes (negative)', async () => {
    create.mockResolvedValue(
      credential({ enabled: true, results: { first: new Uint8Array(16).buffer } }),
    );
    getPasskeyPrfOutput.mockResolvedValue({ credentialId: 'AQIDBA', prfOutput: KEY_MATERIAL });

    await createPasskeyWallet();

    // Deriving from a short buffer would succeed and produce a wrong account rather than fail.
    expect(getPasskeyPrfOutput).toHaveBeenCalledTimes(1);
  });

  it('accepts the plain-array shape 1Password returns (regression)', async () => {
    create.mockResolvedValue(credential({ enabled: true, results: { first: [...KEY_MATERIAL] } }));

    await expect(createPasskeyWallet()).resolves.toMatchObject({ kind: 'passkey' });
    expect(getPasskeyPrfOutput).not.toHaveBeenCalled();
  });

  it('reports the store only after both ceremonies came back empty (positive)', async () => {
    create.mockResolvedValue(credential({ enabled: false }));
    getPasskeyPrfOutput.mockRejectedValue(meraError('Authenticator did not return PRF output'));

    const error: unknown = await createPasskeyWallet().catch((e: unknown) => e);
    const message = (error as Error).message;

    expect((error as { code?: string }).code).toBe('PRF_UNAVAILABLE');
    expect(message).toMatch(/asked twice/i);
    // Named from Mera's tested support matrix. This copy was once inverted against it, sending
    // people to their browser profile — the one desktop-Chrome store guaranteed to fail — and away
    // from iCloud Keychain, which works. A wrong instruction costs more than no instruction.
    expect(message).toMatch(/iCloud Keychain/);
    // Named because it is a platform default that works. Omitted, the list reads to a Windows user
    // as though nothing on their machine is supported.
    expect(message).toMatch(/Windows Hello/);
    // PRF needs `hmac-secret`, which is YubiKey 5.2 and up. A promise that an older key will work
    // is worse than not mentioning keys at all.
    expect(message).toMatch(/most security keys/);
    // Two ways out, and the dead credential named so it does not keep getting picked. The advice
    // points at the browser's save dialog rather than at a button, because that is where the
    // choice is actually made and the panel deliberately offers no third button for it.
    expect(message).toMatch(/asks where to save it/i);
    expect(message).toMatch(/MetaMask/i);
    expect(message).not.toMatch(/button/i);
    expect(message).toMatch(/delete it/i);
  });

  it('names only stores that work, never one that does not (REGRESSION)', async () => {
    create.mockResolvedValue(credential({ enabled: false }));
    getPasskeyPrfOutput.mockRejectedValue(meraError('Authenticator did not return PRF output'));

    const error: unknown = await createPasskeyWallet().catch((e: unknown) => e);

    // A list of stores that failed is a claim with a shelf life, and it is a claim about somebody
    // else's product. Both of these are building on the extension, and nothing gates on the answer
    // any more: signup asks the authenticator instead of predicting, so a store that has since
    // gained support just works and never reaches this message. What a reader needs here is
    // somewhere to go, which the positives already give.
    expect((error as Error).message).not.toMatch(/Bitwarden|Dashlane|Chrome’s own profile/i);
  });

  it('does not send a security key somewhere else to be saved (negative)', async () => {
    create.mockResolvedValue(credential({ enabled: false }));
    getPasskeyPrfOutput.mockRejectedValue(meraError('Authenticator did not return PRF output'));

    const error: unknown = await createPasskeyWallet(undefined, 'cross-device').catch(
      (e: unknown) => e,
    );

    // The retry already left the machine. Repeating "save it in iCloud Keychain" here is advice
    // for a ceremony that did not happen, and it hides the real answer, which is that the device
    // is too old.
    expect((error as Error).message).not.toMatch(/iCloud Keychain/);
    expect((error as Error).message).toMatch(/iOS 18|Android 14/);
  });

  it('steers off this machine when asked to (positive)', async () => {
    create.mockResolvedValue(credential({ enabled: false }));
    getPasskeyPrfOutput.mockResolvedValue({ credentialId: 'AQIDBA', prfOutput: KEY_MATERIAL });

    await createPasskeyWallet(undefined, 'cross-device');

    // The only authenticator a website can ask for by name. Which platform provider a browser uses
    // is its own decision, so without this there is no retry to offer at all.
    expect(creationOptions().hints).toEqual(['hybrid', 'security-key']);
    expect(creationOptions().authenticatorSelection?.authenticatorAttachment).toBe('cross-platform');
  });

  it('leaves the ordinary signup on whatever the browser prefers (regression)', async () => {
    create.mockResolvedValue(credential({ enabled: false }));
    getPasskeyPrfOutput.mockResolvedValue({ credentialId: 'AQIDBA', prfOutput: KEY_MATERIAL });

    await createPasskeyWallet();

    // Face ID is the good path and it is a platform authenticator. Steering everyone to a QR code
    // to protect the minority whose store cannot derive keys would be the wrong trade.
    expect(creationOptions().hints).toBeUndefined();
    expect(creationOptions().authenticatorSelection?.authenticatorAttachment).toBeUndefined();
  });

  it('treats a dismissed create prompt as cancelled (negative)', async () => {
    create.mockRejectedValue(cancelled);
    await expect(createPasskeyWallet()).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('treats a dismissed second prompt as cancelled, not a broken store (MONEY REGRESSION)', async () => {
    create.mockResolvedValue(credential({ enabled: false }));
    // Mera boxes the DOMException inside its own error, so the cancellation arrives named
    // `MeraError` with the message "Passkey assertion failed". Read only at the top level, closing
    // a dialog would tell somebody their passkey store is broken and to delete a working passkey.
    getPasskeyPrfOutput.mockRejectedValue(
      meraError('Passkey assertion failed', 'PASSKEY_OPERATION_FAILED', cancelled),
    );

    await expect(createPasskeyWallet()).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('reports a browser with no WebAuthn at all (negative)', async () => {
    Object.defineProperty(navigator, 'credentials', { value: undefined, configurable: true });
    await expect(createPasskeyWallet()).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });
});

describe('signing in with an existing passkey', () => {
  it('returns the account the passkey derives (positive)', async () => {
    getPasskeyPrfOutput.mockResolvedValue({ credentialId: 'AQIDBA', prfOutput: KEY_MATERIAL });
    await expect(connectPasskeyWallet()).resolves.toMatchObject({
      address: '0xabc',
      kind: 'passkey',
    });
  });

  it('explains a passkey that cannot derive, without offering to move it (regression)', async () => {
    getPasskeyPrfOutput.mockRejectedValue(meraError('Authenticator did not return PRF output'));

    const error: unknown = await connectPasskeyWallet().catch((e: unknown) => e);
    const message = (error as Error).message;

    expect((error as { code?: string }).code).toBe('PRF_UNAVAILABLE');
    // The passkey already exists, so "choose where to save it" is advice for a moment that has
    // passed. What is left is a new account on an authenticator that works, or MetaMask.
    expect(message).toMatch(/Reason: Authenticator did not return PRF output/);
    expect(message).toMatch(/create an account, saving the passkey to one of those/i);
    // Every failed attempt leaves a credential behind, and the browser keeps offering all of them.
    // Without this the list grows, the working one gets harder to find, and picking a dead one
    // reproduces this exact error with no hint that the passkey is the variable.
    expect(message).toMatch(/leaves a passkey behind/i);
  });

  it('treats a dismissed prompt as cancelled (negative)', async () => {
    getPasskeyPrfOutput.mockRejectedValue(
      meraError('Passkey assertion failed', 'PASSKEY_OPERATION_FAILED', cancelled),
    );
    await expect(connectPasskeyWallet()).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
