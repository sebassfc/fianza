/**
 * Fianza's money policy. Pure and deterministic: no I/O, no clock, no model calls.
 * The LLM may add context to a report, but only deterministic evidence can propose a forfeit,
 * and only a maintainer's click can execute one.
 */

export type BondState = "AWAITING_BOND" | "BONDED" | "VOIDED" | "CAPTURED" | "REFUNDED";

export type BondEvent = "AUTHORIZED" | "VOID" | "CAPTURE" | "REFUND";

const transitions: Record<BondState, Partial<Record<BondEvent, BondState>>> = {
  AWAITING_BOND: { AUTHORIZED: "BONDED" },
  BONDED: { VOID: "VOIDED", CAPTURE: "CAPTURED" },
  CAPTURED: { REFUND: "REFUNDED" },
  VOIDED: {},
  REFUNDED: {},
};

export function nextState(state: BondState, event: BondEvent): BondState {
  const next = transitions[state][event];
  if (!next) throw new InvalidTransition(state, event);
  return next;
}

export function canTransition(state: BondState, event: BondEvent): boolean {
  return transitions[state][event] !== undefined;
}

export class InvalidTransition extends Error {
  constructor(
    readonly state: BondState,
    readonly event: BondEvent,
  ) {
    super(`cannot ${event} a bond in state ${state}`);
    this.name = "InvalidTransition";
  }
}

/** One finding in the evidence report. `source` decides whether it can ever count toward a forfeit. */
export type Flag = {
  id: string;
  source: "deterministic" | "llm";
  severity: "hard" | "soft";
  /** Where the evidence lives, e.g. "src/db.ts:42" or a CI check URL. */
  ref?: string;
};

export type Evidence = {
  flags: Flag[];
  /** Prompt-injection markers found in the PR text or diff. Freezes the recommendation. */
  injectionDetected: boolean;
  /** False when a check timed out or failed to run. Incomplete evidence can never forfeit. */
  complete: boolean;
};

export type Recommendation = "VOID" | "REVIEW" | "FORFEIT_PROPOSED";

export const MIN_HARD_FLAGS_TO_FORFEIT = 2;

export function hardDeterministicFlags(evidence: Evidence): Flag[] {
  return evidence.flags.filter((f) => f.source === "deterministic" && f.severity === "hard");
}

export function recommend(evidence: Evidence): Recommendation {
  if (evidence.injectionDetected || !evidence.complete) return "REVIEW";
  const deterministic = evidence.flags.filter((f) => f.source === "deterministic");
  if (hardDeterministicFlags(evidence).length >= MIN_HARD_FLAGS_TO_FORFEIT) return "FORFEIT_PROPOSED";
  if (deterministic.length > 0) return "REVIEW";
  return "VOID";
}

export type CaptureCheck =
  | { allowed: true }
  | { allowed: false; reason: "not_bonded" | "not_proposed" | "no_maintainer_confirmation" | "monthly_cap_reached" };

/** The last gate before money moves. Every condition must hold; there is no override. */
export function canCapture(input: {
  state: BondState;
  recommendation: Recommendation;
  maintainerConfirmed: boolean;
  forfeitsThisMonth: number;
  monthlyForfeitCap: number;
}): CaptureCheck {
  if (input.state !== "BONDED") return { allowed: false, reason: "not_bonded" };
  if (input.recommendation !== "FORFEIT_PROPOSED") return { allowed: false, reason: "not_proposed" };
  if (!input.maintainerConfirmed) return { allowed: false, reason: "no_maintainer_confirmation" };
  if (input.forfeitsThisMonth >= input.monthlyForfeitCap) return { allowed: false, reason: "monthly_cap_reached" };
  return { allowed: true };
}
