/**
 * snarkjs ships no types.
 *
 * Declared here rather than pulled from DefinitelyTyped because only one function is ever called
 * and its shape matters a great deal: `pi_b` is a 2×2 of *strings*, and the Solidity verifier wants
 * each pair swapped. Typing it loosely is how that swap gets forgotten, and a forgotten swap
 * verifies perfectly off chain and fails on chain with nothing but a false from the pairing check.
 *
 * The full surface is much larger. Adding to it is fine; leaving it as `any` is not.
 */
declare module 'snarkjs' {
  export interface Groth16Proof {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
    protocol: string;
    curve: string;
  }

  export const groth16: {
    /** Build the witness and prove in one step. `wasm` and `zkey` may be URLs in the browser. */
    fullProve(
      input: Record<string, unknown>,
      wasm: string,
      zkey: string,
    ): Promise<{ proof: Groth16Proof; publicSignals: string[] }>;

    verify(
      verificationKey: unknown,
      publicSignals: string[],
      proof: Groth16Proof,
    ): Promise<boolean>;
  };
}
