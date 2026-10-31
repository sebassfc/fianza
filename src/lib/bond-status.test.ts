import { describe, expect, it } from "vitest";
import { GET } from "@/app/bond/[owner]/[repo]/[pr]/route";
import { bondStatus, forfeitRateLabel } from "@/lib/bond-status";
import { bondUrl, EXIT, parsePrRef, render } from "@/lib/cli";
import { bondStore, MemoryBondStore, type BondRecord } from "@/lib/store";

const ref = { owner: "acme", repo: "widgets", pr: 42, headSha: "abc1234" };
const ctx = { ref, baseUrl: "https://fianza.test/", amountUsd: "5.00", stats: { bonds: 0, forfeits: 0 }, now: new Date("2026-10-29T18:00:00Z") };
const record = (state: BondRecord["state"], extra: Partial<BondRecord> = {}): BondRecord => ({ ref, state, amountUsd: "5.00", history: [], ...extra });

describe("bondStatus", () => {
  it("answers 402 with terms when no bond exists, and points at the human approval page", () => {
    const { httpStatus, body } = bondStatus(null, ctx);
    expect(httpStatus).toBe(402);
    expect(body).toMatchObject({
      status: "bond_required",
      amount: "5.00",
      currency: "USD",
      approval_url: "https://fianza.test/pay/acme/widgets/42?sha=abc1234",
      repo_forfeit_rate: "no bonds yet",
      expires_at: "2026-10-30T18:00:00.000Z",
    });
    if (body.status === "bond_required") expect(body.message).toMatch(/hold, not a charge/);
  });

  it("answers 200 once the hold exists, and $0 when it is released", () => {
    expect(bondStatus(record("BONDED", { authorizationId: "AUTH-1" }), ctx)).toEqual({
      httpStatus: 200,
      body: { status: "bonded", authorization_id: "AUTH-1", review_within_hours: 48 },
    });
    expect(bondStatus(record("VOIDED"), ctx).body).toEqual({ status: "voided", charged: "0.00" });
  });

  it("a forfeit links to the appeal page", () => {
    expect(bondStatus(record("CAPTURED"), ctx).body).toMatchObject({ status: "forfeited", appeal_url: "https://fianza.test/appeal/acme/widgets/42?sha=abc1234" });
  });

  it("shows the repo's forfeit rate before anyone approves", () => {
    expect(forfeitRateLabel({ bonds: 8, forfeits: 1 })).toBe("1 of 8 (13%)");
  });
});

describe("MemoryBondStore", () => {
  it("counts only bonds that were actually posted, per repo", async () => {
    const s = new MemoryBondStore();
    await s.put(record("BONDED"));
    await s.put({ ...record("CAPTURED"), ref: { ...ref, pr: 43 } });
    await s.put({ ...record("AWAITING_BOND"), ref: { ...ref, pr: 44 } });
    await s.put({ ...record("CAPTURED"), ref: { ...ref, repo: "other" } });
    expect(await s.repoStats("acme", "widgets")).toEqual({ bonds: 2, forfeits: 1 });
  });

  it("returns copies, so callers cannot mutate stored state by accident", async () => {
    const s = new MemoryBondStore();
    await s.put(record("BONDED"));
    const got = await s.get(ref);
    got!.state = "VOIDED";
    expect((await s.get(ref))?.state).toBe("BONDED");
  });

  it("lists the most recently updated bonds first, up to the limit", async () => {
    const s = new MemoryBondStore();
    const at = (pr: number, iso: string) => ({ ...record("BONDED"), ref: { ...ref, pr }, history: [{ at: iso, event: "AUTHORIZED" }] });
    await s.put(at(1, "2026-10-29T10:00:00Z"));
    await s.put(at(2, "2026-10-29T12:00:00Z"));
    await s.put(at(3, "2026-10-29T11:00:00Z"));
    await s.put({ ...record("AWAITING_BOND"), ref: { ...ref, pr: 4 } });
    expect((await s.list()).map((r) => r.ref.pr)).toEqual([2, 3, 1, 4]);
    expect((await s.list({ limit: 2 })).map((r) => r.ref.pr)).toEqual([2, 3]);
    expect((await s.list({ state: "AWAITING_BOND" })).map((r) => r.ref.pr)).toEqual([4]);
  });
});

describe("GET /bond/{owner}/{repo}/{pr}", () => {
  const call = (path: string) => {
    const url = new URL(`https://fianza.test${path}`);
    const [, , owner, repo, pr] = url.pathname.split("/");
    return GET(new Request(url), { params: Promise.resolve({ owner, repo, pr }) });
  };

  it("returns 402 for a PR without a bond, and never caches it", async () => {
    const res = await call("/bond/acme/widgets/7?sha=deadbeef");
    expect(res.status).toBe(402);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).status).toBe("bond_required");
  });

  it("returns 200 after the bond is held", async () => {
    await bondStore().put(record("BONDED", { ref: { ...ref, pr: 8, headSha: "cafe123" }, authorizationId: "AUTH-8" }));
    const res = await call("/bond/acme/widgets/8?sha=cafe123");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "bonded", authorization_id: "AUTH-8" });
  });

  it("rejects a missing or malformed head SHA with 400", async () => {
    expect((await call("/bond/acme/widgets/7")).status).toBe(400);
    expect((await call("/bond/acme/widgets/7?sha=not-a-sha")).status).toBe(400);
  });
});

describe("cli", () => {
  it("parses owner/repo#pr and PR URLs", () => {
    expect(parsePrRef("acme/widgets#42")).toEqual({ owner: "acme", repo: "widgets", pr: 42 });
    expect(parsePrRef("https://github.com/acme/widgets/pull/42")).toEqual({ owner: "acme", repo: "widgets", pr: 42 });
    expect(() => parsePrRef("widgets 42")).toThrow();
  });

  it("builds the bond URL", () => {
    expect(bondUrl("https://fianza.test/", { owner: "acme", repo: "widgets", pr: 42 }, "abc1234")).toBe(
      "https://fianza.test/bond/acme/widgets/42?sha=abc1234",
    );
  });

  it("on 402 tells the agent to stop and exits with the needs-human code", () => {
    const out = render(bondStatus(null, ctx).body);
    expect(out.exit).toBe(EXIT.needsHuman);
    expect(out.text).toContain("https://fianza.test/pay/acme/widgets/42?sha=abc1234");
    expect(out.text).toMatch(/^STOP: do not retry/m);
  });

  it("exits 0 once settled", () => {
    expect(render({ status: "voided", charged: "0.00" }).exit).toBe(EXIT.settled);
  });
});
