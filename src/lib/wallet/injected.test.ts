import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  connectInjectedWallet,
  requestAccountAccess,
  ensureChain,
  findInjectedWallet,
  isContractAccount,
  LEGACY_RDNS,
  subscribeToInjectedWallets,
  type InjectedWallet,
} from './injected';
import { WalletError } from './types';

const EOA = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

/** A scriptable EIP-1193 provider. */
function fakeProvider(handlers: Record<string, (params?: unknown[]) => unknown> = {}) {
  const calls: Array<{ method: string; params?: unknown }> = [];
  return {
    calls,
    request: vi.fn(async ({ method, params }: { method: string; params?: unknown[] }) => {
      calls.push({ method, params });
      const handler = handlers[method];
      if (!handler) throw Object.assign(new Error(`Unhandled ${method}`), { code: -32601 });
      return handler(params);
    }),
  };
}

function wallet(provider: ReturnType<typeof fakeProvider>): InjectedWallet {
  return { rdns: 'io.metamask', name: 'MetaMask', icon: 'data:image/svg+xml,x', provider };
}

const announce = (info: Partial<{ rdns: string; name: string; icon: string }>, provider: unknown) =>
  window.dispatchEvent(
    new CustomEvent('eip6963:announceProvider', {
      detail: {
        info: { uuid: 'u', name: 'MetaMask', icon: 'data:x', rdns: 'io.metamask', ...info },
        provider,
      },
    }),
  );

afterEach(() => {
  delete (window as { ethereum?: unknown }).ethereum;
  vi.restoreAllMocks();
});

describe('EIP-6963 discovery', () => {
  it('collects wallets that announce themselves (positive)', () => {
    const seen: InjectedWallet[][] = [];
    const stop = subscribeToInjectedWallets((w) => seen.push(w));

    announce({}, fakeProvider());

    expect(seen.at(-1)?.map((w) => w.name)).toEqual(['MetaMask']);
    stop();
  });

  it('ignores every wallet but MetaMask (negative)', () => {
    // Every injected wallet speaks the same EIP-1193 methods, so listing all of them is easy and
    // testing all of them is not — and the parts that touch a wallet are the ones where being
    // wrong costs money: `personal_sign` encoding decides which shielded identity you get. A
    // wallet that is offered and then derives the wrong identity is worse than one never offered.
    const seen: InjectedWallet[][] = [];
    const stop = subscribeToInjectedWallets((w) => seen.push(w));

    announce({ rdns: 'io.rabby', name: 'Rabby' }, fakeProvider());
    announce({ rdns: 'com.coinbase.wallet', name: 'Coinbase Wallet' }, fakeProvider());

    expect(seen).toHaveLength(0);
    stop();
  });

  it('never substitutes a different wallet for a named one (MONEY REGRESSION)', async () => {
    // The caller is `reconnectWallet`, re-acquiring the key a session was already derived from.
    // This used to fall through to `wallets[0]`, so a browser whose remembered rdns is no longer
    // offered would be handed MetaMask instead — a DIFFERENT shielded identity, silently, with no
    // error, because both identities are perfectly valid. Anything already in the pool becomes
    // unreachable. Not hypothetical: every browser that signed in with another extension before
    // this build is in exactly that state.
    (window as { ethereum?: unknown }).ethereum = { ...fakeProvider(), isMetaMask: true };
    expect(await findInjectedWallet('io.rabby')).toBeNull();

    // An empty request is a preference written before rdns was recorded — nothing to contradict.
    expect(await findInjectedWallet('')).not.toBeNull();
  });

  it('deduplicates a wallet that announces twice (regression)', () => {
    // Wallets re-announce on every `eip6963:requestProvider`, and the uuid is
    // regenerated each time — keying on it would list MetaMask twice.
    const seen: InjectedWallet[][] = [];
    const stop = subscribeToInjectedWallets((w) => seen.push(w));

    announce({ uuid: 'a' } as never, fakeProvider());
    announce({ uuid: 'b' } as never, fakeProvider());

    expect(seen.at(-1)).toHaveLength(1);
    stop();
  });

  it('ignores an announcement with no rdns (negative)', () => {
    const seen: InjectedWallet[][] = [];
    const stop = subscribeToInjectedWallets((w) => seen.push(w));
    announce({ rdns: '' }, fakeProvider());
    expect(seen).toHaveLength(0);
    stop();
  });

  it('stops listening after unsubscribe (negative)', () => {
    const seen: InjectedWallet[][] = [];
    const stop = subscribeToInjectedWallets((w) => seen.push(w));
    stop();
    announce({}, fakeProvider());
    expect(seen).toHaveLength(0);
  });

  it('falls back to window.ethereum when nothing announces (positive)', async () => {
    // A MetaMask too old to announce over 6963 must still work.
    (window as { ethereum?: unknown }).ethereum = { ...fakeProvider(), isMetaMask: true };
    const seen: InjectedWallet[][] = [];
    const stop = subscribeToInjectedWallets((w) => seen.push(w));

    await Promise.resolve(); // let the queued microtask run

    expect(seen.at(-1)?.[0]?.rdns).toBe(LEGACY_RDNS);
    expect(seen.at(-1)?.[0]?.name).toBe('MetaMask');
    stop();
  });

  it('will not adopt a legacy global that is not MetaMask (negative REGRESSION)', async () => {
    // Whichever extension loaded last owns `window.ethereum`, so without this check the legacy
    // fallback is a back door that relists exactly the wallets the 6963 filter just excluded —
    // and relists them nameless, as "Browser wallet", with no way for the user to tell which.
    (window as { ethereum?: unknown }).ethereum = fakeProvider();
    const seen: InjectedWallet[][] = [];
    const stop = subscribeToInjectedWallets((w) => seen.push(w));

    await Promise.resolve();

    expect(seen).toHaveLength(0);
    stop();
  });

  it('prefers the 6963 announcement over the legacy global (regression)', async () => {
    // Otherwise a user with MetaMask and Rabby gets a nameless "Browser wallet"
    // entry pointing at whichever one won the race for the global.
    (window as { ethereum?: unknown }).ethereum = fakeProvider();
    const seen: InjectedWallet[][] = [];
    const stop = subscribeToInjectedWallets((w) => seen.push(w));

    announce({}, fakeProvider());
    await Promise.resolve();

    expect(seen.at(-1)?.map((w) => w.rdns)).toEqual(['io.metamask']);
    stop();
  });
});

describe('isContractAccount', () => {
  it('treats an empty account as an EOA (positive)', () => {
    expect(isContractAccount('0x')).toBe(false);
    expect(isContractAccount(null)).toBe(false);
    expect(isContractAccount(undefined)).toBe(false);
  });

  it('flags deployed contract code (positive)', () => {
    expect(isContractAccount('0x6080604052')).toBe(true);
  });

  it('accepts an EIP-7702 delegated EOA (regression)', () => {
    // A 7702 account carries code but still signs with its own ECDSA key, so
    // personal_sign recovery works and Unlink is satisfied. Rejecting these
    // would lock out a large and growing share of ordinary MetaMask users.
    expect(isContractAccount(`0xef0100${'11'.repeat(20)}`)).toBe(false);
  });
});

describe('connectInjectedWallet', () => {
  it('returns a signer for an EOA (positive)', async () => {
    const provider = fakeProvider({
      eth_requestAccounts: () => [EOA],
      eth_getCode: () => '0x',
    });
    const signer = await connectInjectedWallet(wallet(provider));

    expect(signer.address).toBe(EOA);
    expect(signer.kind).toBe('injected');
    expect(signer.provider).toBe(provider);
  });

  it('exposes the raw provider so the SDK drives it directly (regression)', async () => {
    // Unlink's `account.fromWallet` is written against a real EIP-1193 wallet.
    // Wrapping it in our Mera shim would add a place for the personal_sign
    // encoding to drift and silently derive a different shielded identity.
    const provider = fakeProvider({ eth_requestAccounts: () => [EOA], eth_getCode: () => '0x' });
    const signer = await connectInjectedWallet(wallet(provider));
    expect(signer.provider).toBe(provider);
    expect(signer.evmAccount).toBeUndefined();
  });

  it('rejects a smart-contract wallet with actionable copy (negative)', async () => {
    const provider = fakeProvider({
      eth_requestAccounts: () => [EOA],
      eth_getCode: () => '0x6080604052348015',
    });

    await expect(connectInjectedWallet(wallet(provider))).rejects.toMatchObject({
      code: 'SMART_ACCOUNT',
    });
  });

  it('connects anyway when the wallet will not answer eth_getCode (negative)', async () => {
    // The real gate is Unlink's signature-recovery check. Refusing to connect
    // because a provider is stingy about eth_getCode would block valid users.
    const provider = fakeProvider({ eth_requestAccounts: () => [EOA] });
    await expect(connectInjectedWallet(wallet(provider))).resolves.toMatchObject({ address: EOA });
  });

  it('maps a user rejection to CANCELLED, not an error (negative)', async () => {
    const provider = fakeProvider({
      eth_requestAccounts: () => {
        throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
      },
    });

    await expect(connectInjectedWallet(wallet(provider))).rejects.toMatchObject({
      code: 'CANCELLED',
    });
  });

  it('rejects when the wallet shares no account (negative)', async () => {
    const provider = fakeProvider({ eth_requestAccounts: () => [] });
    await expect(connectInjectedWallet(wallet(provider))).rejects.toBeInstanceOf(WalletError);
  });

  it('rejects a malformed address rather than trusting it (negative)', async () => {
    const provider = fakeProvider({ eth_requestAccounts: () => ['not-an-address'] });
    await expect(connectInjectedWallet(wallet(provider))).rejects.toMatchObject({
      code: 'CANCELLED',
    });
  });

  it('does not expose disconnect — the extension keeps the key (regression)', async () => {
    const provider = fakeProvider({ eth_requestAccounts: () => [EOA], eth_getCode: () => '0x' });
    const signer = await connectInjectedWallet(wallet(provider));
    expect(signer.disconnect).toBeUndefined();
  });
});

/*
  Asking the wallet which account to share.

  The bug: `eth_requestAccounts` does not mean "ask the user". For an origin that already holds an
  `eth_accounts` permission, MetaMask answers it from the stored permission with no dialog, so it
  returns the account granted however long ago whatever the extension is currently showing. A user
  who switched accounts found the site still signed in as the old one, with no way forward except
  opening MetaMask and connecting the new account by hand.

  Every test in the block above passes in that world, which is why these exist.
*/
describe('connectInjectedWallet, choosing an account', () => {
  const GRANT = [{ parentCapability: 'eth_accounts' }];

  it('asks the wallet to re-offer its accounts before requesting them (positive)', async () => {
    const provider = fakeProvider({
      wallet_requestPermissions: () => GRANT,
      eth_requestAccounts: () => [EOA],
      eth_getCode: () => '0x',
    });

    await connectInjectedWallet(wallet(provider), { chooseAccount: true });

    // The order is the feature, not an implementation detail. Once `eth_requestAccounts` has
    // answered from the stored permission the picker has been skipped, and asking afterwards
    // changes nothing about the account this connect returns.
    expect(provider.calls.map((c) => c.method)).toEqual([
      'wallet_requestPermissions',
      'eth_requestAccounts',
      'eth_getCode',
    ]);
  });

  it('sends the exact params the permission spec requires (regression)', async () => {
    const provider = fakeProvider({
      wallet_requestPermissions: () => GRANT,
      eth_requestAccounts: () => [EOA],
      eth_getCode: () => '0x',
    });

    await connectInjectedWallet(wallet(provider), { chooseAccount: true });

    // EIP-2255 wraps the request in an array. A bare `{ eth_accounts: {} }` type checks perfectly
    // against the provider signature and fails only against a real extension, with `-32602` and a
    // message about params that names nothing useful. So does `['eth_accounts']`.
    expect(provider.calls[0].params).toEqual([{ eth_accounts: {} }]);
  });

  it('re-acquiring the key never opens the account picker (MONEY REGRESSION)', async () => {
    const provider = fakeProvider({ eth_requestAccounts: () => [EOA], eth_getCode: () => '0x' });

    await connectInjectedWallet(wallet(provider), { chooseAccount: false });

    // Unlocking, the faucet, depositing and the admin resolve all re-acquire the key an existing
    // session was derived from. A picker there offers a choice whose only correct answer is the
    // account already in use, and the wrong answer seeds a different shielded identity.
    const methods = provider.calls.map((c) => c.method);
    expect(methods).toContain('eth_requestAccounts');
    expect(methods).not.toContain('wallet_requestPermissions');
  });

  it('defaults to silent, so a new call site cannot ask by accident (regression)', async () => {
    const provider = fakeProvider({ eth_requestAccounts: () => [EOA], eth_getCode: () => '0x' });

    await connectInjectedWallet(wallet(provider));

    // Exactly one caller wants the picker. Making it opt in means a future call site is safe by
    // default and has to say so to become unsafe.
    expect(provider.calls.map((c) => c.method)).not.toContain('wallet_requestPermissions');
  });

  it('connects anyway when the wallet has never heard of the method (negative)', async () => {
    // There is no capability discovery: EIP-6963 announces that a wallet exists and says nothing
    // about which methods it implements, so the only signal is the failure.
    const provider = fakeProvider({
      wallet_requestPermissions: () => {
        throw Object.assign(new Error('Method not found'), { code: -32601 });
      },
      eth_requestAccounts: () => [EOA],
      eth_getCode: () => '0x',
    });

    const signer = await connectInjectedWallet(wallet(provider), { chooseAccount: true });
    expect(signer.address).toBe(EOA);
  });

  it('connects anyway when the wallet refuses the method outright (negative)', async () => {
    // 4200 is EIP-1193's "unsupported method", which several wallets return instead of -32601.
    const provider = fakeProvider({
      wallet_requestPermissions: () => {
        throw Object.assign(new Error('Unsupported method'), { code: 4200 });
      },
      eth_requestAccounts: () => [EOA],
      eth_getCode: () => '0x',
    });

    await expect(
      connectInjectedWallet(wallet(provider), { chooseAccount: true }),
    ).resolves.toMatchObject({ address: EOA });
  });

  it('connects anyway when the permission request fails for no stated reason (negative)', async () => {
    // No code at all. Enumerating the codes that mean "I cannot do this" would turn the next
    // unlisted one into a user who cannot sign in, under an error that reads as "you have no
    // wallet" — and the legacy branch of discovery adopts any provider claiming `isMetaMask`,
    // which Coinbase, Trust, OKX and Rabby all do.
    const provider = fakeProvider({
      wallet_requestPermissions: () => {
        throw new Error('boom');
      },
      eth_requestAccounts: () => [EOA],
      eth_getCode: () => '0x',
    });

    await expect(
      connectInjectedWallet(wallet(provider), { chooseAccount: true }),
    ).resolves.toMatchObject({ address: EOA });
  });

  it('treats a permission answer of undefined as no answer, not as a grant (negative)', async () => {
    const provider = fakeProvider({
      wallet_requestPermissions: () => undefined,
      eth_requestAccounts: () => [EOA],
      eth_getCode: () => '0x',
    });

    await expect(
      connectInjectedWallet(wallet(provider), { chooseAccount: true }),
    ).resolves.toMatchObject({ address: EOA });
  });

  it('maps a declined picker to CANCELLED and never asks for accounts (negative)', async () => {
    const provider = fakeProvider({
      wallet_requestPermissions: () => {
        throw Object.assign(new Error('User rejected the request'), { code: 4001 });
      },
      eth_requestAccounts: () => [EOA],
      eth_getCode: () => '0x',
    });

    await expect(
      connectInjectedWallet(wallet(provider), { chooseAccount: true }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    // Falling through to `eth_requestAccounts` would sign them in as the account they just
    // declined to confirm, which is the opposite of what dismissing the dialog means.
    expect(provider.calls.map((c) => c.method)).not.toContain('eth_requestAccounts');
  });

  it('reports a dialog that is already open rather than stacking a second (negative)', async () => {
    // Reachable by double clicking the wallet row. Falling through would hit the same -32002 one
    // call later, mapped to UNSUPPORTED, whose copy advises unlocking an extension that is not
    // locked.
    const provider = fakeProvider({
      wallet_requestPermissions: () => {
        throw Object.assign(new Error('Already processing'), { code: -32002 });
      },
      eth_requestAccounts: () => [EOA],
      eth_getCode: () => '0x',
    });

    await expect(
      connectInjectedWallet(wallet(provider), { chooseAccount: true }),
    ).rejects.toMatchObject({ code: 'REQUEST_PENDING' });
    expect(provider.calls.map((c) => c.method)).not.toContain('eth_requestAccounts');
  });

  it('reads the address from eth_requestAccounts, never from the grant (MONEY REGRESSION)', async () => {
    const OTHER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
    const provider = fakeProvider({
      // A caveat naming a different account first. The shape is not contractual: the caveat name
      // has already changed once historically and MetaMask's own documented example returns an
      // empty list. Two sources for the address that seeds the shielded identity is exactly the
      // drift this codebase is built to avoid.
      wallet_requestPermissions: () => [
        { parentCapability: 'eth_accounts', caveats: [{ type: 'restrictReturnedAccounts', value: [OTHER] }] },
      ],
      eth_requestAccounts: () => [EOA],
      eth_getCode: () => '0x',
    });

    const signer = await connectInjectedWallet(wallet(provider), { chooseAccount: true });
    expect(signer.address).toBe(EOA);
  });

  it('reports whether the wallet actually asked, for callers that only wanted the picker', async () => {
    // Connecting does not care: it falls through to `eth_requestAccounts` and gets an account
    // either way. The signed-in "Use a different account" button is the whole operation, and a
    // swallowed failure there is a control that does nothing and says nothing.
    const answered = fakeProvider({ wallet_requestPermissions: () => GRANT });
    await expect(requestAccountAccess(answered)).resolves.toBe(true);

    const mute = fakeProvider({});
    await expect(requestAccountAccess(mute)).resolves.toBe(false);
  });

  it('asks once per connect, even when the wallet will not answer eth_getCode (negative)', async () => {
    const provider = fakeProvider({
      wallet_requestPermissions: () => GRANT,
      eth_requestAccounts: () => [EOA],
    });

    await connectInjectedWallet(wallet(provider), { chooseAccount: true });

    expect(provider.calls.filter((c) => c.method === 'wallet_requestPermissions')).toHaveLength(1);
  });
});

describe('ensureChain', () => {
  const MONAD = {
    id: 10143,
    name: 'Monad Testnet',
    rpcUrls: ['https://testnet-rpc.monad.xyz', 'https://monad-testnet.drpc.org'],
    symbol: 'MON',
  };

  it('does nothing when already on the right chain (positive)', async () => {
    const provider = fakeProvider({ eth_chainId: () => '0x279f' });
    await ensureChain(provider, MONAD);
    expect(provider.calls.map((c) => c.method)).toEqual(['eth_chainId']);
  });

  it('is case-insensitive about the returned chain id (regression)', async () => {
    // Some wallets return uppercase hex; a naive compare would switch chains
    // that are already correct, prompting the user for nothing.
    const provider = fakeProvider({ eth_chainId: () => '0x279F' });
    await ensureChain(provider, MONAD);
    expect(provider.calls).toHaveLength(1);
  });

  it('switches when on the wrong chain (positive)', async () => {
    const provider = fakeProvider({
      eth_chainId: () => '0x1',
      wallet_switchEthereumChain: () => null,
    });
    await ensureChain(provider, MONAD);
    expect(provider.calls.at(-1)).toMatchObject({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0x279f' }],
    });
  });

  it('adds the chain when the wallet has never seen it (positive)', async () => {
    const provider = fakeProvider({
      eth_chainId: () => '0x1',
      wallet_switchEthereumChain: () => {
        throw Object.assign(new Error('Unrecognized chain ID'), { code: 4902 });
      },
      wallet_addEthereumChain: () => null,
    });

    await ensureChain(provider, MONAD);

    const added = provider.calls.at(-1);
    expect(added?.method).toBe('wallet_addEthereumChain');
    expect((added?.params as [{ chainId: string; rpcUrls: string[] }])[0]).toMatchObject({
      chainId: '0x279f',
      // Every endpoint, not just the first: a wallet that learns one RPC hangs
      // at "confirming" as soon as that endpoint throttles, and the extension
      // owns the broadcast so the site can neither see nor fix it.
      rpcUrls: MONAD.rpcUrls,
    });
  });

  it('surfaces a declined switch instead of proceeding (negative)', async () => {
    // Sending on the wrong chain is a real-money mistake, so a refusal has to
    // stop the flow rather than fall through to `wallet_addEthereumChain`.
    const provider = fakeProvider({
      eth_chainId: () => '0x1',
      wallet_switchEthereumChain: () => {
        throw Object.assign(new Error('User rejected'), { code: 4001 });
      },
    });

    await expect(ensureChain(provider, MONAD)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(provider.calls.map((c) => c.method)).not.toContain('wallet_addEthereumChain');
  });

  it('reports a failed add as a network problem (negative)', async () => {
    const provider = fakeProvider({
      eth_chainId: () => '0x1',
      wallet_switchEthereumChain: () => {
        throw Object.assign(new Error('unknown'), { code: 4902 });
      },
      wallet_addEthereumChain: () => {
        throw new Error('nope');
      },
    });

    await expect(ensureChain(provider, MONAD)).rejects.toMatchObject({ code: 'WRONG_NETWORK' });
  });
});
