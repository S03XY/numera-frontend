// @vitest-environment node
//
// Live probe against monad-testnet and a running backend. Skipped unless RELAY_PROBE=1.
//
//   cd frontend && RELAY_PROBE=1 DEPLOYER_KEY=0x... npx vitest run src/lib/execution/relay.probe.test.ts
//
// ## Why this repeats every operation
//
// The last live probe of this system passed while the product was broken. It funded a market
// account **once**, and the defect — Unlink's `execute()` refusing any account it had already
// deployed — only appeared on the *second* funded operation against the same account. A one-pass
// probe cannot see a bug whose precondition is "this has happened before", and most of the
// interesting state in an execution layer is exactly that: nonces, allowances, deployed code,
// accumulated positions.
//
// So every operation below runs at least twice, against the same account, and the second pass
// asserts the same things as the first.
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  erc20Abi,
  http,
  parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, toHex } from 'viem';
import { marketAccount, type ExecutionRoot } from './keys';
import {
  encodeRelayableCall,
  readRelayState,
  signForwardRequest,
  signPermit,
  toRelayPayload,
} from './relay';

const RUN = process.env.RELAY_PROBE === '1';
const RPC = process.env.RPC_HTTP_URL ?? 'https://testnet-rpc.monad.xyz';
const RELAY = process.env.RELAY_URL ?? 'http://localhost:3001';
const CHAIN_ID = 10143;

const ENGINE = '0x1714FEA46837d5F5382270a40C21782bb6B3f42c' as const;
const FORWARDER = '0xC59ea13B24609F11e513DB0C576D455caF1302F0' as const;
const TOKEN = '0xB950d6ab271c752f3b27dbc10441f4e1ca4d71af' as const;
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as const;
const MARKET_ID = 0n;
const OUTCOME = 0n;

const UNIT = 1_000_000n;
/** Comfortably above `minTradeCost` (5 USDC) so the floor is not what is under test here. */
const SHARES = 20n * UNIT;

/**
 * Slippage tolerance, in basis points, applied to every quote before it becomes a guard.
 *
 * Not padding for its own sake: the engine's spread carries a time term that widens as a market
 * approaches close, so a quote read now is already stale by the block the transaction lands in. A
 * `maxCost` equal to the quote reverts — measured at two base units on a market a day from close,
 * and it grows as close approaches. The UI applies the same tolerance, user-selectable.
 */
const SLIPPAGE_BPS = 100n;
const withSlippageUp = (q: bigint) => q + (q * SLIPPAGE_BPS) / 10_000n;
const withSlippageDown = (q: bigint) => q - (q * SLIPPAGE_BPS) / 10_000n;

const ENGINE_ABI = parseAbi([
  'function quoteBuy(uint256,uint256,uint256) view returns (uint256)',
  'function quoteSell(uint256,uint256,uint256) view returns (uint256)',
  'function quoteBuyComplement(uint256,uint256,uint256) view returns (uint256)',
  'function quoteSellComplement(uint256,uint256,uint256) view returns (uint256)',
  'function sharesOf(uint256,address,uint256) view returns (uint256)',
  'function collateralOf(uint256) view returns (uint256)',
  'function feesAccrued(address) view returns (uint256)',
]);

const monad = defineChain({
  id: CHAIN_ID,
  name: 'monad-testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

const rpc = createPublicClient({ chain: monad, transport: http(RPC) });

/**
 * A fresh root per run, so each probe gets an account that has never traded.
 *
 * Deterministic within the run, random across runs: reusing one would make the second execution of
 * the probe start from the state the first left behind, which is exactly the confusion this file
 * exists to avoid.
 */
const ROOT = keccak256(toHex(`numera-probe-${Date.now()}-${process.pid}`)) as ExecutionRoot;
const MARKET_REF = 'probe-market-0';
const signer = marketAccount(ROOT, MARKET_REF);

async function submit(data: `0x${string}`, withPermit: boolean) {
  const state = await readRelayState({
    rpc,
    forwarder: FORWARDER,
    token: TOKEN,
    spender: ENGINE,
    account: signer.address,
  });

  const permit = withPermit
    ? await signPermit({
        account: signer,
        token: TOKEN,
        tokenName: state.tokenName,
        tokenVersion: state.tokenVersion,
        spender: ENGINE,
        chainId: CHAIN_ID,
        nonce: state.permitNonce,
      })
    : undefined;

  const request = await signForwardRequest({
    account: signer,
    forwarder: FORWARDER,
    chainId: CHAIN_ID,
    to: ENGINE,
    data,
    nonce: state.forwarderNonce,
  });

  const response = await fetch(`${RELAY}/api/relay`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'omit',
    body: JSON.stringify(toRelayPayload(request, permit)),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`relay ${response.status}: ${JSON.stringify(body)}`);

  const receipt = await rpc.waitForTransactionReceipt({ hash: body.hash });
  if (receipt.status !== 'success') throw new Error(`reverted: ${body.hash}`);
  return { hash: body.hash as `0x${string}`, gasUsed: receipt.gasUsed };
}

const sharesOf = (who: `0x${string}`) =>
  rpc.readContract({
    address: ENGINE,
    abi: ENGINE_ABI,
    functionName: 'sharesOf',
    args: [MARKET_ID, who, OUTCOME],
  });

const tokenOf = (who: `0x${string}`) =>
  rpc.readContract({ address: TOKEN, abi: erc20Abi, functionName: 'balanceOf', args: [who] });

describe.skipIf(!RUN)('the relayed execution layer, live', () => {
  beforeAll(async () => {
    const key = process.env.DEPLOYER_KEY;
    if (!key) throw new Error('DEPLOYER_KEY is required to mint probe collateral');

    // Collateral arrives as it would from a shielded-pool withdrawal: the account receives tokens
    // and nothing else. Deliberately no native gas — that is the property under test.
    const admin = privateKeyToAccount(key as `0x${string}`);
    const wallet = createWalletClient({ account: admin, chain: monad, transport: http(RPC) });
    const hash = await wallet.writeContract({
      address: TOKEN,
      abi: parseAbi(['function mint(address,uint256)']),
      functionName: 'mint',
      args: [signer.address, 1_000n * UNIT],
    });
    await rpc.waitForTransactionReceipt({ hash });
  }, 120_000);

  it('starts from an account with collateral and no gas (precondition)', async () => {
    expect(await tokenOf(signer.address)).toBe(1_000n * UNIT);
    expect(await rpc.getBalance({ address: signer.address })).toBe(0n);
  });

  it('places a bet, twice, from an account that never holds gas (REGRESSION)', async () => {
    // The first buy carries the permit; the second must succeed with no permit at all, because the
    // allowance is already there. A second operation failing where the first succeeded is the
    // precise shape of the defect that froze funds under the previous design.
    for (const pass of [1, 2]) {
      const before = await sharesOf(signer.address);
      const quoted = await rpc.readContract({
        address: ENGINE,
        abi: ENGINE_ABI,
        functionName: 'quoteBuy',
        args: [MARKET_ID, OUTCOME, SHARES],
      });

      const { gasUsed } = await submit(
        encodeRelayableCall('buy', [MARKET_ID, OUTCOME, SHARES, withSlippageUp(quoted)]),
        pass === 1,
      );

      expect(await sharesOf(signer.address), `pass ${pass}: position not credited`).toBe(
        before + SHARES,
      );
      // The whole privacy claim: the account trades, and never acquires a balance that would let
      // anyone fund it publicly.
      expect(await rpc.getBalance({ address: signer.address }), `pass ${pass}: LEAK`).toBe(0n);
      console.log(`  buy pass ${pass}: ${gasUsed} gas, quoted ${quoted}`);
    }
  }, 180_000);

  it('credits the trader and never the forwarder or relayer (REGRESSION)', async () => {
    // If any trader path had kept `msg.sender`, every user's position would pool into one shared,
    // publicly-visible address.
    expect(await sharesOf(FORWARDER)).toBe(0n);
    expect(await sharesOf('0xa68a271FC1000AF23E8601E9bC55c6828A4b6201')).toBe(0n);
    expect(await sharesOf(signer.address)).toBeGreaterThan(0n);
  });

  it('charges the fee, and the quote matches what was paid (positive)', async () => {
    expect(
      await rpc.readContract({
        address: ENGINE,
        abi: ENGINE_ABI,
        functionName: 'feesAccrued',
        args: [TOKEN],
      }),
    ).toBeGreaterThan(0n);
  });

  it('sells, twice, and pays the account each time (positive)', async () => {
    for (const pass of [1, 2]) {
      const sharesBefore = await sharesOf(signer.address);
      const cashBefore = await tokenOf(signer.address);
      const quoted = await rpc.readContract({
        address: ENGINE,
        abi: ENGINE_ABI,
        functionName: 'quoteSell',
        args: [MARKET_ID, OUTCOME, 10n * UNIT],
      });

      await submit(
        encodeRelayableCall('sell', [MARKET_ID, OUTCOME, 10n * UNIT, withSlippageDown(quoted)]),
        false,
      );

      expect(await sharesOf(signer.address), `pass ${pass}`).toBe(sharesBefore - 10n * UNIT);
      // Within the tolerance rather than exact, for the same reason the guard has one.
      const received = (await tokenOf(signer.address)) - cashBefore;
      expect(received, `pass ${pass}: proceeds`).toBeGreaterThanOrEqual(withSlippageDown(quoted));
      expect(await rpc.getBalance({ address: signer.address }), `pass ${pass}: LEAK`).toBe(0n);
      console.log(`  sell pass ${pass}: received ${quoted}`);
    }
  }, 180_000);

  it('opens and closes a short on a three-outcome book, twice (REGRESSION)', async () => {
    // The heaviest relayable path, and the one with the most to go wrong: `buyComplement` writes a
    // leg per outcome, and `sellComplement` unwinds all of them atomically. Run on market 1, which
    // has three outcomes — on a binary book a short is just the other side and proves much less.
    //
    // It is also the gas worst case, which is what the relayer's cap has to accommodate: clamping a
    // limit below what this needs would send a transaction guaranteed to run out of gas.
    const SHORT_MARKET = 1n;
    const shortShares = 15n * UNIT;

    const legShares = (outcome: bigint) =>
      rpc.readContract({
        address: ENGINE,
        abi: ENGINE_ABI,
        functionName: 'sharesOf',
        args: [SHORT_MARKET, signer.address, outcome],
      });

    for (const pass of [1, 2]) {
      const before = await legShares(1n);
      const quoted = await rpc.readContract({
        address: ENGINE,
        abi: ENGINE_ABI,
        functionName: 'quoteBuyComplement',
        args: [SHORT_MARKET, 0n, shortShares],
      });

      const { gasUsed } = await submit(
        encodeRelayableCall('buyComplement', [
          SHORT_MARKET,
          0n,
          shortShares,
          withSlippageUp(quoted),
        ]),
        false,
      );

      // A short on outcome 0 is one share of every *other* outcome, and never of outcome 0 itself.
      expect(await legShares(1n), `pass ${pass}: leg 1`).toBe(before + shortShares);
      expect(await legShares(2n), `pass ${pass}: leg 2`).toBe(before + shortShares);
      expect(await legShares(0n), `pass ${pass}: the shorted outcome must never be held`).toBe(0n);
      expect(await rpc.getBalance({ address: signer.address }), `pass ${pass}: LEAK`).toBe(0n);
      console.log(`  short pass ${pass}: ${gasUsed} gas, quoted ${quoted}`);
    }

    // Unwind the whole basket in one call. Separate leg sales would be one relayed transaction
    // each, and a revert partway through leaves the trader holding an unbalanced remainder.
    const held = await legShares(1n);
    const exitQuote = await rpc.readContract({
      address: ENGINE,
      abi: ENGINE_ABI,
      functionName: 'quoteSellComplement',
      args: [SHORT_MARKET, 0n, held],
    });
    const { gasUsed } = await submit(
      encodeRelayableCall('sellComplement', [SHORT_MARKET, 0n, held, withSlippageDown(exitQuote)]),
      false,
    );

    expect(await legShares(1n), 'leg 1 not closed').toBe(0n);
    expect(await legShares(2n), 'leg 2 not closed').toBe(0n);
    expect(await rpc.getBalance({ address: signer.address }), 'LEAK').toBe(0n);
    console.log(`  short close: ${gasUsed} gas, received ~${exitQuote}`);
  }, 240_000);

  it('refuses a request the forwarder does not allow (negative)', async () => {
    // `createMarket` is the most expensive call on the engine and moves seed capital. The relay
    // must reject it without spending anything.
    const state = await readRelayState({
      rpc,
      forwarder: FORWARDER,
      token: TOKEN,
      spender: ENGINE,
      account: signer.address,
    });
    const request = await signForwardRequest({
      account: signer,
      forwarder: FORWARDER,
      chainId: CHAIN_ID,
      to: ENGINE,
      // createMarket(...) selector with junk args; the selector is what matters.
      data: `0x1281311e${'00'.repeat(128)}`,
      nonce: state.forwarderNonce,
    });

    const response = await fetch(`${RELAY}/api/relay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(toRelayPayload(request)),
    });
    expect(response.ok).toBe(false);
    expect(response.status).toBe(400);
  }, 60_000);

  it('refuses a request signed by somebody else (REGRESSION)', async () => {
    // The account's collateral must be movable only by the key it was derived from.
    const attacker = marketAccount(
      keccak256(toHex('attacker')) as ExecutionRoot,
      'probe-market-0',
    );
    const state = await readRelayState({
      rpc,
      forwarder: FORWARDER,
      token: TOKEN,
      spender: ENGINE,
      account: attacker.address,
    });
    const request = await signForwardRequest({
      account: attacker,
      forwarder: FORWARDER,
      chainId: CHAIN_ID,
      to: ENGINE,
      data: encodeRelayableCall('buy', [MARKET_ID, OUTCOME, SHARES, 1_000_000_000n]),
      nonce: state.forwarderNonce,
    });
    // Claim to be the funded account while signing as somebody else.
    const payload = toRelayPayload(request);
    payload.request.from = signer.address;

    const response = await fetch(`${RELAY}/api/relay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(response.ok).toBe(false);
  }, 60_000);

  it('grants Permit2 its allowance by signature, with no gas (REGRESSION)', async () => {
    // The step that made the return leg impossible. The shielded pool will not move a deposit
    // without a Permit2 allowance, and a market account can never send `approve` — it holds no
    // native gas, by design. So the allowance is signed and our relayer submits it.
    //
    // This was never exercised: the unit test mocked the pool and accepted the wrong object shape,
    // so live it surfaced as "this wallet has no account selected" the first time anyone withdrew.
    const state = await readRelayState({
      rpc,
      forwarder: FORWARDER,
      token: TOKEN,
      spender: PERMIT2,
      account: signer.address,
    });
    expect(state.tokenVersion).toBe('2');

    const permit = await signPermit({
      account: signer,
      token: TOKEN,
      tokenName: state.tokenName,
      tokenVersion: state.tokenVersion,
      spender: PERMIT2,
      chainId: CHAIN_ID,
      nonce: state.permitNonce,
    });

    const response = await fetch(`${RELAY}/api/relay/permit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: TOKEN,
        owner: signer.address,
        spender: PERMIT2,
        value: permit.value.toString(),
        deadline: permit.deadline.toString(),
        v: permit.v,
        r: permit.r,
        s: permit.s,
      }),
    });
    const body = await response.json();
    expect(response.ok, JSON.stringify(body)).toBe(true);
    await rpc.waitForTransactionReceipt({ hash: body.hash });

    const granted = await rpc.readContract({
      address: TOKEN,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [signer.address, PERMIT2],
    });
    expect(granted).toBeGreaterThan(0n);
    expect(await rpc.getBalance({ address: signer.address }), 'LEAK').toBe(0n);
    console.log(`  permit2 allowance granted: ${granted}`);
  }, 120_000);

  it('leaves the account holding exactly what the books say (conservation)', async () => {
    const held = await tokenOf(signer.address);
    const shares = await sharesOf(signer.address);
    console.log(`  final: ${held} tUSDC, ${shares} shares, 0 MON`);
    expect(await rpc.getBalance({ address: signer.address })).toBe(0n);
    expect(held + shares).toBeGreaterThan(0n);
  });
});
