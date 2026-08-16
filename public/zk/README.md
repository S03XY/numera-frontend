# Proving artifacts

The browser needs these three files to produce a withdrawal proof. They are served over HTTP from
`/zk/…`, which is why they live in `public/` rather than anywhere tidier: a proving key that is
`import`ed gets inlined into a bundle, and this one is 17MB.

| File | What it is |
| --- | --- |
| `withdraw.wasm` | The compiled circuit. Turns witness inputs into a witness. |
| `withdraw.zkey` | The Groth16 proving key, from a completed phase-2 ceremony. |
| `withdraw.vkey` | The verifying key. Only used by scripts; on chain the verifier contract holds its own copy. |

## Where they came from

Copied unmodified from [0xbow's privacy-pools-core](https://github.com/0xbow-io/privacy-pools-core),
`packages/circuits`: the build output for `withdraw.circom` and the final keys from their trusted
setup. A local clone is in `resources/privacy-pools-core/` for reference.

They are **not** regenerated as part of any build here. Recompiling the circuit would need circom, a
powers-of-tau file, and a fresh phase-2 ceremony, and would produce keys that no longer match the
`WithdrawalVerifier.sol` deployed on chain. If the circuit ever changes, all three of these, the
verifier contract and the deployment move together.

## The one invariant

`withdraw.zkey` and the deployed `WithdrawalVerifier` must come from the same ceremony. If they
drift, every proof verifies locally and fails on chain. `contracts/script/pool-e2e.mjs` is what
catches that: it proves with these artifacts and submits to a real verifier.
