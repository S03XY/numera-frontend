/**
 * Facts about the chain and the collateral, with no vendor attached.
 *
 * These lived in `unlink/config.ts` because that file happened to be first. They are not Unlink's
 * and never were: the chain id is bound into every key derivation, the collateral address is what
 * the wallet screen shows a balance of, and the faucet is where a Monad testnet user gets gas.
 */

/** Monad testnet. Bound into key derivation, so a wrong value forks every account silently. */
export const DEFAULT_CHAIN_ID = 10143;

/**
 * Monad's own faucet, the only source of the gas this chain needs.
 *
 * Quoted in two places — the wallet panel that notices an account holding no MON, and the testnet
 * notice in the masthead that says so before anybody has pressed anything. Two copies of a URL
 * drift, so there is one.
 */
export const MONAD_FAUCET_URL = 'https://faucet.monad.xyz';

/**
 * The collateral every market settles in, and the only token the wallet screen moves.
 *
 * Markets carry their own `collateral` address, so this is used only before any market is loaded:
 * balances, and the faucet.
 */
export const COLLATERAL_ADDRESS = process.env.NEXT_PUBLIC_COLLATERAL_ADDRESS ?? '';

/** USDC-style base units, matching `TestUSDC.decimals()`. */
export const COLLATERAL_DECIMALS = 6;
