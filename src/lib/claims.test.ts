import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { buildEvidence } from "@/lib/evidence";
import { recommend } from "@/lib/policy";
import { checkClaims, groundReport, type ClaimReport } from "./claims";

const diff = `diff --git a/src/sum.ts b/src/sum.ts
--- a/src/sum.ts
+++ b/src/sum.ts
@@ -1,3 +1,4 @@
 export function sum(a: number, b: number) {
+  if (!Number.isFinite(a) || !Number.isFinite(b)) throw new RangeError("not finite");
   return a + b;
 }
`;

const report = (claims: ClaimReport["claims"]): ClaimReport => ({ claims, summary_en: "s", summary_es: "s" });

/** A stand-in for the SDK client: only beta.messages.parse is used. */
function fakeClient(respond: (params: Record<string, unknown>) => unknown) {
  const calls: Record<string, unknown>[] = [];
  const client = {
    beta: {
      messages: {
        parse: async (params: Record<string, unknown>) => {
          calls.push(params);
          return respond(params);
        },
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

describe("groundReport", () => {
  it("keeps citations that exist in the diff", () => {
    const g = groundReport(report([{ claim: "Rejects NaN", status: "supported", diff_refs: ["src/sum.ts:2"], note: "guard added" }]), diff);
    expect(g.report.claims[0]).toMatchObject({ status: "supported", diff_refs: ["src/sum.ts:2"] });
    expect(g.flags).toEqual([]);
  });

  it("a claim backed only by invented citations becomes unknown and raises no flag", () => {
    const g = groundReport(report([{ claim: "Fixes the leak in #42", status: "unsupported", diff_refs: ["src/db.ts:99"], note: "x" }]), diff);
    expect(g.report.claims[0]).toMatchObject({ status: "unknown", diff_refs: [] });
    expect(g.flags).toEqual([]);
  });

  it("an unsupported claim with a real citation is a soft LLM flag, which can never forfeit", () => {
    const g = groundReport(report([{ claim: "Adds tests", status: "unsupported", diff_refs: ["src/sum.ts:2"], note: "no test files" }]), diff);
    expect(g.flags).toEqual([{ id: "claim_unsupported", source: "llm", severity: "soft", ref: "src/sum.ts:2" }]);
    const evidence = buildEvidence({ diff, ci: { conclusion: "success" }, texts: [], extraFlags: g.flags });
    expect(recommend(evidence)).toBe("VOID");
  });
});

describe("checkClaims", () => {
  const input = { title: "Reject NaN", body: "Rechaza NaN en sum.", diff };

  it("calls Claude Opus 5.5 with structured output, medium effort and default fallbacks", async () => {
    const { client, calls } = fakeClient(() => ({
      stop_reason: "end_turn",
      parsed_output: report([{ claim: "Rechaza NaN en sum", status: "supported", diff_refs: ["src/sum.ts:2"], note: "guard" }]),
      usage: { input_tokens: 2_000, output_tokens: 500 },
    }));
    const r = await checkClaims(input, { client });
    expect(r).toMatchObject({ complete: true, cached: false, flags: [] });
    if (r.complete) expect(r.usd).toBeCloseTo((2_000 * 4 + 500 * 20) / 1_000_000, 8);
    expect(calls[0]).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default", betas: ["server-side-fallback-2026-07-01"] });
    expect((calls[0].output_config as { effort: string }).effort).toBe("medium");
  });

  it("the same PR is answered from cache at $0", async () => {
    const { client, calls } = fakeClient(() => ({ stop_reason: "end_turn", parsed_output: report([]), usage: { input_tokens: 1, output_tokens: 1 } }));
    const cachedInput = { ...input, title: "cache me" };
    await checkClaims(cachedInput, { client });
    const second = await checkClaims(cachedInput, { client });
    expect(second).toMatchObject({ complete: true, cached: true, usd: 0 });
    expect(calls).toHaveLength(1);
  });

  it("a refusal makes the evidence incomplete, never a forfeit", async () => {
    const { client } = fakeClient(() => ({ stop_reason: "refusal", parsed_output: null, usage: { input_tokens: 1, output_tokens: 0 } }));
    expect(await checkClaims({ ...input, title: "refused" }, { client })).toMatchObject({ complete: false, reason: "refusal" });
  });

  it("a timeout degrades to incomplete", async () => {
    const { client } = fakeClient(() => {
      throw new Anthropic.APIConnectionTimeoutError();
    });
    expect(await checkClaims({ ...input, title: "slow" }, { client })).toMatchObject({ complete: false, reason: "timeout" });
  });

  it("refuses to send a giant diff instead of silently truncating it", async () => {
    const { client, calls } = fakeClient(() => ({}));
    expect(await checkClaims({ ...input, diff: "x".repeat(300_001) }, { client })).toMatchObject({ complete: false, reason: "diff_too_large" });
    expect(calls).toHaveLength(0);
  });

  it("without an API key reports itself not configured instead of failing the webhook", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(await checkClaims({ ...input, title: "no key" })).toMatchObject({ complete: false, reason: "not_configured" });
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it("incomplete claim checks freeze the recommendation at REVIEW", () => {
    const slop = `diff --git a/a.test.ts b/a.test.ts\n--- a/a.test.ts\n+++ b/a.test.ts\n@@ -1 +1 @@\n-expect(f()).toBe(2)\n+it.skip("x", () => expect(true).toBe(true))\n`;
    const evidence = buildEvidence({ diff: slop, ci: { conclusion: "failure" }, texts: [], externalChecksComplete: false });
    expect(recommend(evidence)).toBe("REVIEW");
  });
});
