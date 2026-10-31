import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ClaimCheck } from "@/lib/claims";
import { MemoryBondStore } from "@/lib/store";
import type { GitHubApi } from "./api";
import { appJwt, verifyGitHubSignature } from "./auth";
import { handleGitHubEvent, type HandlerDeps } from "./handler";

describe("verifyGitHubSignature", () => {
  const body = '{"action":"opened"}';
  const sig = `sha256=${createHmac("sha256", "s3cret").update(body).digest("hex")}`;
  it("accepts the right HMAC and rejects anything else", () => {
    expect(verifyGitHubSignature(body, sig, "s3cret")).toBe(true);
    expect(verifyGitHubSignature(body + " ", sig, "s3cret")).toBe(false);
    expect(verifyGitHubSignature(body, sig, "other")).toBe(false);
    expect(verifyGitHubSignature(body, null, "s3cret")).toBe(false);
    expect(verifyGitHubSignature(body, "sha1=abc", "s3cret")).toBe(false);
  });
});

describe("appJwt", () => {
  it("is an RS256 JWT valid for 9 minutes, backdated 60 s", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwt = appJwt("12345", privateKey.export({ type: "pkcs8", format: "pem" }).toString(), 1_000_000);
    const [h, p, s] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(p, "base64url").toString())).toEqual({ iat: 999_940, exp: 1_000_540, iss: "12345" });
    expect(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(s, "base64url"))).toBe(true);
  });
});

const SHA = "abc1234def5678";
const slopDiff = `diff --git a/src/a.test.ts b/src/a.test.ts\n--- a/src/a.test.ts\n+++ b/src/a.test.ts\n@@ -1 +1 @@\n-it("x", () => { expect(f()).toBe(2); });\n+it.skip("x", () => { expect(true).toBe(true); });\n`;

function fakeGitHub(over: { declared?: boolean; ci?: "success" | "failure"; maintainer?: boolean; headSha?: string } = {}) {
  const log: string[] = [];
  const comments: string[] = [];
  const api: GitHubApi = {
    pullRequest: async () => ({
      title: "Fix f",
      body: over.declared === false ? "Hand-written fix." : "Fixes f.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)",
      headSha: over.headSha ?? SHA,
      author: "agent-op",
      authorType: "User",
      labels: [],
      commitMessages: [],
    }),
    diff: async () => slopDiff,
    ciStatus: async () => (over.ci === "success" ? { conclusion: "success" } : { conclusion: "failure", url: "https://ci/run/1" }),
    comment: async (_o, _r, pr, body) => {
      comments.push(body);
      log.push(`comment:${pr}`);
    },
    setLabel: async (_o, _r, pr, label) => void log.push(`label:${pr}:${label}`),
    isMaintainer: async () => over.maintainer ?? true,
  };
  return { api, log, comments };
}

const okClaims = async (): Promise<ClaimCheck> => ({
  complete: true,
  report: { claims: [{ claim: "Fixes f", status: "unknown", diff_refs: [], note: "n" }], summary_en: "Tests were skipped.", summary_es: "Se saltaron pruebas." },
  flags: [],
  usd: 0.01,
  ms: 900,
  cached: false,
});

function deps(gh: GitHubApi, store = new MemoryBondStore(), over: Partial<HandlerDeps> = {}): HandlerDeps {
  return {
    github: gh,
    store,
    baseUrl: "https://fianza.test",
    amountUsd: "5.00",
    checkClaims: okClaims,
    decisions: {
      voidBond: async () => {},
      captureBond: async () => ({ captureId: "CAP-1" }),
      refundBond: async () => ({}),
      getAuthorization: async () => ({ status: "CREATED" }),
      getCapture: async () => ({ status: "COMPLETED" }),
      forfeitsThisMonth: async () => 0,
      monthlyForfeitCap: 5,
      now: () => new Date("2026-10-31T12:00:00Z"),
    },
    now: () => new Date("2026-10-31T12:00:00Z"),
    ...over,
  };
}

const repository = { name: "widgets", owner: { login: "acme" } };
const prOpened = { action: "opened", number: 42, repository };
const suiteDone = { action: "completed", check_suite: { head_sha: SHA, pull_requests: [{ number: 42 }] }, repository };
const comment = (body: string, user = { login: "lena", type: "User" }) => ({ action: "created", issue: { number: 42, pull_request: {} }, comment: { body, user }, repository });

describe("handleGitHubEvent", () => {
  it("an agent-declared PR gets one bilingual bond request with the pay link and a label", async () => {
    const gh = fakeGitHub();
    const store = new MemoryBondStore();
    expect(await handleGitHubEvent("pull_request", prOpened, deps(gh.api, store))).toBe("bond_requested");
    expect(gh.log).toEqual(["label:42:fianza:awaiting-bond", "comment:42"]);
    expect(gh.comments[0]).toContain(`https://fianza.test/pay/acme/widgets/42?sha=${SHA}`);
    expect(gh.comments[0]).toContain("Español");
    expect(await handleGitHubEvent("pull_request", { ...prOpened, action: "synchronize" }, deps(gh.api, store))).toBe("already_requested");
    expect(gh.comments).toHaveLength(1);
  });

  it("a human PR is never asked for money", async () => {
    const gh = fakeGitHub({ declared: false });
    expect(await handleGitHubEvent("pull_request", prOpened, deps(gh.api))).toBe("human_pr_free_lane");
    expect(gh.log).toEqual([]);
  });

  it("when CI finishes, posts the evidence report with the AI claim section and the recommendation label", async () => {
    const gh = fakeGitHub();
    const store = new MemoryBondStore();
    await handleGitHubEvent("pull_request", prOpened, deps(gh.api, store));
    expect(await handleGitHubEvent("check_suite", suiteDone, deps(gh.api, store))).toBe("reported:1");
    expect(gh.comments[1]).toContain("Forfeit proposed");
    expect(gh.comments[1]).toContain("Claim check (AI, informational: it never moves money)");
    expect(gh.log.at(-1)).toBe("label:42:fianza:forfeit-proposed");
    expect((await store.get({ owner: "acme", repo: "widgets", pr: 42, headSha: SHA }))?.recommendation).toBe("FORFEIT_PROPOSED");
  });

  it("an incomplete claim check caps the recommendation at review", async () => {
    const gh = fakeGitHub();
    const store = new MemoryBondStore();
    await handleGitHubEvent("pull_request", prOpened, deps(gh.api, store));
    await handleGitHubEvent("check_suite", suiteDone, deps(gh.api, store, { checkClaims: async () => ({ complete: false, reason: "timeout", ms: 45_000 }) }));
    expect(gh.log.at(-1)).toBe("label:42:fianza:needs-review");
  });

  it("ignores a check suite for an older commit", async () => {
    const gh = fakeGitHub({ headSha: "fffffff0000000" });
    expect(await handleGitHubEvent("check_suite", suiteDone, deps(gh.api))).toBe("nothing_to_report");
  });

  it("/fianza forfeit by a maintainer captures a proposed forfeit; by anyone else it is refused", async () => {
    const store = new MemoryBondStore();
    await store.put({ ref: { owner: "acme", repo: "widgets", pr: 42, headSha: SHA }, state: "BONDED", amountUsd: "5.00", authorizationId: "AUTH-1", recommendation: "FORFEIT_PROPOSED", history: [] });

    const outsider = fakeGitHub({ maintainer: false });
    expect(await handleGitHubEvent("issue_comment", comment("/fianza forfeit", { login: "rando", type: "User" }), deps(outsider.api, store))).toBe("refused:not_maintainer");

    const gh = fakeGitHub();
    expect(await handleGitHubEvent("issue_comment", comment("/fianza cobrar"), deps(gh.api, store))).toBe("decided:forfeit");
    expect(gh.log).toContain("label:42:fianza:forfeited");
  });

  it("never reacts to bots (no loops) or to comments without a command", async () => {
    const gh = fakeGitHub();
    expect(await handleGitHubEvent("issue_comment", comment("/fianza accept", { login: "fianza[bot]", type: "Bot" }), deps(gh.api))).toBe("ignored_bot");
    expect(await handleGitHubEvent("issue_comment", comment("nice work"), deps(gh.api))).toBe("no_command");
  });

  it("a PayPal failure during a decision is reported and changes nothing", async () => {
    const store = new MemoryBondStore();
    const ref = { owner: "acme", repo: "widgets", pr: 42, headSha: SHA };
    await store.put({ ref, state: "BONDED", amountUsd: "5.00", authorizationId: "AUTH-1", history: [] });
    const gh = fakeGitHub();
    const d = deps(gh.api, store);
    d.decisions.voidBond = async () => {
      throw new Error("void bond failed: 503");
    };
    expect(await handleGitHubEvent("issue_comment", comment("/fianza accept"), d)).toBe("paypal_error");
    expect((await store.get(ref))?.state).toBe("BONDED");
  });
});
