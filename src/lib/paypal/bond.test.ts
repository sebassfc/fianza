import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type BondOp, type BondRef, bondLabel, requestId } from "./bond";

// Property callbacks use block bodies: fast-check treats a returned `false` as a failure.

const ref = fc.record<BondRef>({
  owner: fc.stringMatching(/^[a-z0-9-]{1,39}$/),
  repo: fc.stringMatching(/^[a-z0-9._-]{1,100}$/),
  pr: fc.integer({ min: 1, max: 999_999 }),
  headSha: fc.stringMatching(/^[0-9a-f]{40}$/),
});
const ops: BondOp[] = ["create", "authorize", "void", "capture", "reauthorize", "refund"];

describe("requestId", () => {
  it("is deterministic, so a retry reuses the same PayPal-Request-Id", () => {
    fc.assert(
      fc.property(ref, fc.constantFrom(...ops), (r, op) => {
        expect(requestId(r, op)).toBe(requestId({ ...r }, op));
      }),
    );
  });

  it("differs per operation, so void and capture never collide", () => {
    fc.assert(
      fc.property(ref, (r) => {
        expect(new Set(ops.map((op) => requestId(r, op))).size).toBe(ops.length);
      }),
    );
  });

  it("differs per head commit, so a new push needs a new bond", () => {
    fc.assert(
      fc.property(ref, fc.stringMatching(/^[0-9a-f]{40}$/), (r, sha) => {
        fc.pre(sha.slice(0, 12) !== r.headSha.slice(0, 12));
        expect(requestId({ ...r, headSha: sha }, "capture")).not.toBe(requestId(r, "capture"));
      }),
    );
  });

  it("stays within PayPal's header length", () => {
    fc.assert(
      fc.property(ref, fc.constantFrom(...ops), (r, op) => {
        expect(requestId(r, op).length).toBeLessThanOrEqual(108);
      }),
    );
  });
});

describe("bondLabel", () => {
  it("fits PayPal's 127-character custom_id", () => {
    fc.assert(
      fc.property(ref, (r) => {
        expect(bondLabel(r).length).toBeLessThanOrEqual(127);
      }),
    );
  });
});
