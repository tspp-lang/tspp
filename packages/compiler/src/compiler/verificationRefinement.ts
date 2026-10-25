import { Node } from "./types.js";
import {
  VerificationAssertion,
  VerificationTerm,
} from "./verificationIR.js";

/**
 * Solver-specific refinement state layered on top of TypeScript's checker.
 * It records symbolic values and proof assumptions, but it is not a second
 * implementation of TypeScript narrowing or assignability.
 *
 * @internal
 */
export interface VerificationRefinementState {
  readonly values: Map<string, VerificationTerm>;
  /** Proof facts on this path, each tagged with why it holds. */
  readonly facts: VerificationAssertion[];
  reason?: string;
}

/** @internal */
export interface VerificationReturnPath {
  readonly state: VerificationRefinementState;
  readonly value?: VerificationTerm;
  readonly node: Node;
}

/** @internal */
export interface VerificationFlowResult {
  readonly live: VerificationRefinementState[];
  readonly returns: VerificationReturnPath[];
}

/** @internal */
export function cloneVerificationRefinementState(state: VerificationRefinementState): VerificationRefinementState {
  return { values: new Map(state.values), facts: [...state.facts], reason: state.reason };
}

/** @internal */
export function stopVerificationRefinement(state: VerificationRefinementState, reason: string): VerificationFlowResult {
  state.reason = reason;
  return { live: [state], returns: [] };
}
