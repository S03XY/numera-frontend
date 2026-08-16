import {
  encodeAbiParameters,
  encodeFunctionData,
  parseAbi,
  parseAbiParameters,
  type WalletClient,
} from 'viem';
import { endpoints } from '@/lib/api/endpoints';
import type { PoolState } from '@/lib/api/types';
import { monadTestnet, publicClient } from '@/lib/chain/evm';
import type { HeldValue, ShieldedBalance, ShieldedPool } from '@/lib/execution/pool';
import type { ExecutionRoot } from '@/lib/execution/keys';
import { POOL_CONFIG } from './config';
import { poolKeys, depositNote, precommitmentOf } from './keys';
import { buildTrees, noteMatchesLeaf, recoverNotes, selectNotes } from './notes';
import { proveWithdrawal } from './proof';

/**
 * Numera's shielded pool, as a {@link ShieldedPool}.
 *
 * This is the file that replaces Unlink. The interface above it was written to make that a driver
 * swap rather than a rewrite — see `execution/pool.ts` on why it has exactly four methods and no
 * vendor types — and the execution layer, the trade flow and the wallet screen are unchanged by it.
 *
 * ## The three flows, and where each one's privacy comes from
 *
 * **In** ({@link ShieldedPool.deposit}) is public and cheap. A wallet is seen sending collateral to
 * the entrypoint. Nothing is hidden and nothing needs to be: what the deposit buys is a note whose
 * preimage only the depositor knows.
 *
 * **Out** ({@link ShieldedPool.withdraw}) is where the privacy budget is spent. The browser proves
 * it owns *some* note in the tree without saying which, our relayer submits, and the recipient is
 * sealed inside the proof's context so the relayer cannot redirect it. On chain this looks like the
 * pool paying an address, with nothing tying it to whoever deposited.
 *
 * **Back in**, from a market execution account that holds no gas, is the same as the first flow
 * except the account signs instead of sending. See the `sponsored` branch of `deposit`.
 *
 * ## What this deliberately does not do
 *
 * No local note database, no export button, no recovery file. Every note is derived from one
 * signature, so a trader with a cleared browser and a new laptop signs in and their balance is
 * there. `notes.ts` explains the walk.
 */

const ERC20_ABI = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function nonces(address owner) view returns (uint256)',
]);

const ENTRYPOINT_ABI = parseAbi([
  'function deposit(uint256 value, uint256 precommitment) returns (uint256)',
  'function shieldNonces(address owner) view returns (uint256)',
]);

export class PoolError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PoolError';
  }
}

/** How long a signed return instruction stays valid. Long enough to survive a slow relayer. */
const SHIELD_TTL_SECONDS = 30 * 60;

export interface NumeraPoolParams {
  /** The secret every note descends from. Never leaves the browser. */
  root: ExecutionRoot;
  /** Progress for the long steps. Proving takes seconds and silence reads as a hang. */
  onStatus?: (status: string) => void;
}

export const POOL_STATUS = {
  proving: 'Proving ownership of your private balance',
  submitting: 'Submitting to the shielded pool',
  depositing: 'Moving collateral into your private balance',
} as const;

export function numeraPool(params: NumeraPoolParams): ShieldedPool {
  const { root, onStatus } = params;
  if (!POOL_CONFIG.enabled) {
    throw new PoolError(POOL_CONFIG.reason);
  }
  const config = POOL_CONFIG;
  const keys = poolKeys(root);

  /** One read of the pool's public state, used for every operation that follows it. */
  async function state(): Promise<PoolState> {
    const data = await endpoints.pool.state();
    if (!data.enabled) {
      throw new PoolError('This deployment has no shielded pool configured.');
    }
    return data;
  }

  return {
    async balance(): Promise<ShieldedBalance> {
      const data = await state();
      const { total } = recoverNotes(keys, data.leaves);
      return {
        total,
        /*
          Identical to `total`, and that is a property of this pool rather than laziness.

          Unlink reported a lower `spendable` because its index attributed change asynchronously, so
          a healthy account could briefly read zero right after a trade — the behaviour that made a
          $5 bet look like $500 disappearing. Here a change note exists in the tree the moment its
          withdrawal is mined, and `recoverNotes` finds it in the same pass. There is no interval
          during which value is real but unusable, so there is nothing to hold back.
        */
        spendable: total,
        pendingChange: 0n,
        // The mirror lagging is the one case where this figure understates, so it travels with it.
        syncing: !data.synced,
      };
    },

    /**
     * Nothing can be stranded here, so there is nothing to report.
     *
     * The interface carries {@link HeldValue} because Unlink could accept a withdrawal, reserve its
     * notes and never finish, leaving a balance that read lower with no explanation. This pool has
     * no such state: a withdrawal either lands, and the change note is in the tree, or it reverts,
     * and the original note is untouched. There is no third outcome to explain to anybody.
     */
    async held(): Promise<HeldValue> {
      return { total: 0n, operations: [] };
    },

    async deposit({ token, amount, wallet, sponsored }): Promise<void> {
      if (amount <= 0n) throw new PoolError('Deposit amount must be greater than zero.');
      const account = wallet.account;
      if (!account) throw new PoolError('This wallet has no account selected.');

      const data = await state();
      // The index a new note should take. Read fresh rather than remembered: two deposits in one
      // session must not collide, and the second one's index depends on the first being indexed.
      const { nextDepositIndex } = recoverNotes(keys, data.leaves);
      const note = depositNote(keys, nextDepositIndex);
      const precommitment = precommitmentOf(note);

      if (sponsored) {
        await shieldBySignature({ wallet, token, amount, precommitment, entrypoint: config.entrypoint });
        return;
      }

      onStatus?.(POOL_STATUS.depositing);
      const rpc = publicClient();
      const allowance = await rpc.readContract({
        address: token as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [account.address, config.entrypoint],
      });

      // Exactly this deposit, never unlimited. One extra prompt per deposit, in exchange for an
      // allowance that can never exceed the sum the user actually agreed to.
      if (allowance < amount) {
        const approval = await wallet.sendTransaction({
          account,
          chain: monadTestnet,
          to: token as `0x${string}`,
          data: encodeFunctionData({
            abi: ERC20_ABI,
            functionName: 'approve',
            args: [config.entrypoint, amount],
          }),
        });
        const receipt = await rpc.waitForTransactionReceipt({ hash: approval });
        if (receipt.status !== 'success') {
          throw new PoolError('The approval transaction failed, so nothing was deposited.');
        }
      }

      const hash = await wallet.sendTransaction({
        account,
        chain: monadTestnet,
        to: config.entrypoint,
        data: encodeFunctionData({
          abi: ENTRYPOINT_ABI,
          functionName: 'deposit',
          args: [amount, precommitment],
        }),
      });
      const receipt = await rpc.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') {
        throw new PoolError('The deposit transaction failed. Your collateral was not moved.');
      }
    },

    async withdraw({ amount, recipient }): Promise<void> {
      if (amount <= 0n) throw new PoolError('Withdrawal amount must be greater than zero.');
      if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
        throw new PoolError('That is not a valid destination address.');
      }

      const data = await state();
      if (!data.synced) {
        // Proving against a short tree produces a root the chain has never held, and the failure
        // arrives half a minute later as a revert naming the root rather than the cause.
        throw new PoolError(
          'The privacy layer is still catching up. Nothing was sent — try again in a moment.',
        );
      }

      const { notes, total } = recoverNotes(keys, data.leaves);
      if (total < amount) {
        throw new PoolError(
          `Not enough in your private balance: you hold ${total} and asked to move ${amount}.`,
        );
      }
      const plan = selectNotes(notes, amount);
      if (!plan) throw new PoolError('Your private balance cannot cover that in one go.');

      const trees = buildTrees(data.leaves);
      if (trees.state.root !== BigInt(data.stateRoot)) {
        // The served leaves do not reproduce the chain's root, so something is missing or
        // reordered. Refusing here beats generating a proof that is certain to be rejected.
        throw new PoolError(
          'The privacy layer is out of step with the chain. Nothing was sent — try again shortly.',
        );
      }

      const withdrawal = {
        processooor: data.entrypoint as `0x${string}`,
        data: encodeAbiParameters(parseAbiParameters('address'), [recipient as `0x${string}`]),
      };
      const scope = BigInt(data.scope);

      /*
        One proof per note, submitted in sequence.

        The circuit spends exactly one note and mints one change note, so a withdrawal larger than
        any single note is genuinely several withdrawals. They are sequential rather than parallel
        because each one changes the state tree, and a proof built against the tree as it was before
        its predecessor landed is rejected. Slower, and the only version that is correct.
      */
      let remaining = amount;
      for (const note of plan) {
        if (!noteMatchesLeaf(note)) {
          throw new PoolError('Could not verify one of your notes against the pool. Nothing was sent.');
        }
        const take = remaining < note.value ? remaining : note.value;

        onStatus?.(POOL_STATUS.proving);
        const proof = await proveWithdrawal({
          keys,
          note,
          amount: take,
          state: trees.state,
          asp: trees.asp,
          aspIndex: trees.aspIndexOf(note.label),
          scope,
          withdrawal,
        });

        onStatus?.(POOL_STATUS.submitting);
        await endpoints.pool.withdraw({ withdrawal, proof });
        remaining -= take;

        // Every leg after the first must prove against the tree the previous leg left behind, so
        // the state is re-read rather than reused. See the note above on why this is sequential.
        if (remaining > 0n) {
          const next = await state();
          const rebuilt = buildTrees(next.leaves);
          trees.state = rebuilt.state;
          trees.asp = rebuilt.asp;
          trees.aspIndexOf = rebuilt.aspIndexOf;
        }
      }
    },
  };
}

/**
 * Return a gasless account's balance to the pool, paid for by the relayer.
 *
 * Two signatures and no transaction. The permit grants the entrypoint an allowance the account
 * could never `approve` into existence; the `Shield` signature names the note, which is what makes
 * an open relay endpoint safe — a submitter who altered the precommitment, the amount or the owner
 * would produce a signature that recovers to nobody.
 *
 * Neither signature is a prompt the trader sees: this key is derived in the browser, not held by a
 * wallet extension.
 */
async function shieldBySignature(params: {
  wallet: WalletClient;
  token: string;
  amount: bigint;
  precommitment: bigint;
  entrypoint: `0x${string}`;
}): Promise<void> {
  const { wallet, token, amount, precommitment, entrypoint } = params;
  const account = wallet.account;
  if (!account) throw new PoolError('This wallet has no account selected.');

  const rpc = publicClient();
  const deadline = BigInt(Math.floor(Date.now() / 1000) + SHIELD_TTL_SECONDS);
  const chainId = POOL_CONFIG.enabled ? POOL_CONFIG.chainId : 0;

  const [allowance, shieldNonce] = await Promise.all([
    rpc.readContract({
      address: token as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [account.address, entrypoint],
    }),
    rpc.readContract({
      address: entrypoint,
      abi: ENTRYPOINT_ABI,
      functionName: 'shieldNonces',
      args: [account.address],
    }),
  ]);

  const request = {
    owner: account.address,
    value: amount,
    precommitment,
    deadline,
  };

  const signature = await wallet.signTypedData({
    account,
    domain: {
      name: 'Numera Shielded Pool',
      version: '1',
      chainId,
      verifyingContract: entrypoint,
    },
    types: {
      Shield: [
        { name: 'owner', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'precommitment', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'Shield',
    message: { ...request, nonce: shieldNonce },
  });

  // Only when it is actually needed. The permit is bundled rather than sent alone precisely so a
  // stranger cannot have us pay for their approvals.
  let permit: { deadline: string; v: number; r: string; s: string } | undefined;
  if (allowance < amount) {
    const nonce = await rpc.readContract({
      address: token as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'nonces',
      args: [account.address],
    });
    const raw = await wallet.signTypedData({
      account,
      // Version "2", not "1". Circle's USDC uses "2" and TestUSDC matches it; a client that assumes
      // "1" produces a permit that recovers to a *different address* and reverts with nothing that
      // explains why.
      domain: { name: 'USD Coin', version: '2', chainId, verifyingContract: token as `0x${string}` },
      types: {
        Permit: [
          { name: 'owner', type: 'address' },
          { name: 'spender', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      primaryType: 'Permit',
      message: {
        owner: account.address,
        spender: entrypoint,
        value: amount,
        nonce,
        deadline,
      },
    });
    permit = {
      deadline: deadline.toString(),
      v: Number(`0x${raw.slice(130, 132)}`),
      r: `0x${raw.slice(2, 66)}`,
      s: `0x${raw.slice(66, 130)}`,
    };
  }

  await endpoints.pool.shield({
    request: {
      owner: request.owner,
      value: request.value.toString(),
      precommitment: request.precommitment.toString(),
      deadline: request.deadline.toString(),
    },
    signature,
    permit,
  });
}
