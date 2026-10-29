import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type BondEvent,
  type BondState,
  type Evidence,
  type Flag,
  canCapture,
  canTransition,
  nextState,
  recommend,
} from "./index";

const flag = fc.record<Flag>({
  id: fc.string({ minLength: 1, maxLength: 12 }),
  source: fc.constantFrom("deterministic", "llm"),
  severity: fc.constantFrom("hard", "soft"),
});
const llmFlag = flag.map((f) => ({ ...f, source: "llm" as const }));
const evidence = fc.record<Evidence>({
  flags: fc.array(flag, { maxLength: 8 }),
  injectionDetected: fc.boolean(),
  complete: fc.boolean(),
});
const states: BondState[] = ["AWAITING_BOND", "BONDED", "VOIDED", "CAPTURED", "REFUNDED"];
const events: BondEvent[] = ["AUTHORIZED", "VOID", "CAPTURE", "REFUND"];

describe("recommend", () => {
  it("clean evidence voids the bond", () => {
    expect(recommend({ flags: [], injectionDetected: false, complete: true })).toBe("VOID");
  });

  it("LLM flags never change the recommendation", () => {
    fc.assert(
      fc.property(evidence, fc.array(llmFlag, { minLength: 1, maxLength: 8 }), (e, extra) => {
        expect(recommend({ ...e, flags: [...e.flags, ...extra] })).toBe(recommend(e));
      }),
    );
  });

  it("prompt injection always freezes at REVIEW", () => {
    fc.assert(
      fc.property(evidence, (e) => {
        expect(recommend({ ...e, injectionDetected: true })).toBe("REVIEW");
      }),
    );
  });

  it("incomplete evidence can never propose a forfeit", () => {
    fc.assert(
      fc.property(evidence, (e) => {
        expect(recommend({ ...e, complete: false })).not.toBe("FORFEIT_PROPOSED");
      }),
    );
  });

  it("a forfeit needs at least two hard deterministic flags", () => {
    fc.assert(
      fc.property(evidence, (e) => {
        const hard = e.flags.filter((f) => f.source === "deterministic" && f.severity === "hard").length;
        if (recommend(e) === "FORFEIT_PROPOSED") expect(hard).toBeGreaterThanOrEqual(2);
      }),
    );
  });

  it("flag order does not matter", () => {
    fc.assert(
      fc.property(evidence, (e) => {
        expect(recommend({ ...e, flags: [...e.flags].reverse() })).toBe(recommend(e));
      }),
    );
  });
});

describe("canCapture", () => {
  const input = fc.record({
    state: fc.constantFrom(...states),
    recommendation: fc.constantFrom("VOID", "REVIEW", "FORFEIT_PROPOSED" as const),
    maintainerConfirmed: fc.boolean(),
    forfeitsThisMonth: fc.nat(20),
    monthlyForfeitCap: fc.nat(20),
  });

  it("never allows a capture without an explicit maintainer confirmation", () => {
    fc.assert(
      fc.property(input, (i) => {
        expect(canCapture({ ...i, maintainerConfirmed: false }).allowed).toBe(false);
      }),
    );
  });

  it("allows a capture only when every condition holds", () => {
    fc.assert(
      fc.property(input, (i) => {
        const expected =
          i.state === "BONDED" &&
          i.recommendation === "FORFEIT_PROPOSED" &&
          i.maintainerConfirmed &&
          i.forfeitsThisMonth < i.monthlyForfeitCap;
        expect(canCapture(i).allowed).toBe(expected);
      }),
    );
  });
});

describe("bond state machine", () => {
  it("follows the bond lifecycle", () => {
    expect(nextState("AWAITING_BOND", "AUTHORIZED")).toBe("BONDED");
    expect(nextState("BONDED", "VOID")).toBe("VOIDED");
    expect(nextState("BONDED", "CAPTURE")).toBe("CAPTURED");
    expect(nextState("CAPTURED", "REFUND")).toBe("REFUNDED");
  });

  it("voided and refunded bonds are final", () => {
    for (const e of events) {
      expect(canTransition("VOIDED", e)).toBe(false);
      expect(canTransition("REFUNDED", e)).toBe(false);
    }
  });

  it("money only moves out of BONDED, and only once", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...events), { maxLength: 10 }), (seq) => {
        let state: BondState = "AWAITING_BOND";
        let captures = 0;
        for (const e of seq) {
          if (!canTransition(state, e)) {
            expect(() => nextState(state, e)).toThrow();
            continue;
          }
          if (e === "CAPTURE") captures++;
          state = nextState(state, e);
        }
        expect(captures).toBeLessThanOrEqual(1);
      }),
    );
  });
});
