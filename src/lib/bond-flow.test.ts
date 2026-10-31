import { describe, expect, it } from "vitest";
import { confirmBond, payPageUrl, startBond, type ConfirmDeps, type StartDeps } from "@/lib/bond-flow";
import { MemoryBondStore } from "@/lib/store";

const ref = { owner: "acme", repo: "widgets", pr: 42, headSha: "abc1234" };
const now = () => new Date("2026-10-31T12:00:00Z");

function startDeps(store = new MemoryBondStore()) {
  const urls: { returnUrl: string; cancelUrl: string }[] = [];
  const d: StartDeps = {
    store,
    createOrder: async (_ref, u) => (urls.push(u), { orderId: "ORDER-1", status: "PAYER_ACTION_REQUIRED", approvalUrl: "https://paypal/approve" }),
    amountUsd: "5.00",
    baseUrl: "https://fianza.test",
    now,
  };
  return { d, urls, store };
}

describe("startBond", () => {
  it("creates the AUTHORIZE order on click and records it as awaiting the hold", async () => {
    const { d, urls, store } = startDeps();
    expect(await startBond(ref, d)).toEqual({ ok: true, orderId: "ORDER-1" });
    expect(await store.get(ref)).toMatchObject({ state: "AWAITING_BOND", orderId: "ORDER-1", amountUsd: "5.00" });
    expect(urls[0]).toEqual({
      returnUrl: "https://fianza.test/pay/acme/widgets/42?sha=abc1234&approved=1",
      cancelUrl: "https://fianza.test/pay/acme/widgets/42?sha=abc1234&cancelled=1",
    });
  });

  it("refuses to start a second bond once one is held", async () => {
    const { d, store } = startDeps();
    await store.put({ ref, state: "BONDED", amountUsd: "5.00", authorizationId: "AUTH-1", history: [] });
    expect(await startBond(ref, d)).toEqual({ ok: false, reason: "already_bonded" });
  });
});

describe("confirmBond", () => {
  const confirmDeps = (store: MemoryBondStore, status = "CREATED"): ConfirmDeps & { calls: string[] } => {
    const calls: string[] = [];
    return {
      store,
      authorize: async (orderId) => (calls.push(orderId), { authorizationId: "AUTH-1", status, amount: "5.00", expirationTime: "2026-11-29T12:00:00Z" }),
      now,
      calls,
    };
  };

  it("places the hold and stores the authorization and its expiry", async () => {
    const { d, store } = startDeps();
    await startBond(ref, d);
    const c = confirmDeps(store);
    expect(await confirmBond(ref, "ORDER-1", c)).toEqual({ ok: true, authorizationId: "AUTH-1" });
    expect(await store.get(ref)).toMatchObject({ state: "BONDED", authorizationId: "AUTH-1", authorizationExpiresAt: "2026-11-29T12:00:00Z" });
  });

  it("is idempotent: a second confirmation does not authorize again", async () => {
    const { d, store } = startDeps();
    await startBond(ref, d);
    const c = confirmDeps(store);
    await confirmBond(ref, "ORDER-1", c);
    expect(await confirmBond(ref, "ORDER-1", c)).toEqual({ ok: true, authorizationId: "AUTH-1", already: true });
    expect(c.calls).toEqual(["ORDER-1"]);
  });

  it("rejects an order that is not this bond's", async () => {
    const { d, store } = startDeps();
    await startBond(ref, d);
    expect(await confirmBond(ref, "ORDER-EVIL", confirmDeps(store))).toEqual({ ok: false, reason: "order_mismatch" });
    expect(await confirmBond({ ...ref, pr: 99 }, "ORDER-1", confirmDeps(store))).toEqual({ ok: false, reason: "unknown_order" });
  });

  it("does not mark the bond held if PayPal did not create the authorization", async () => {
    const { d, store } = startDeps();
    await startBond(ref, d);
    expect(await confirmBond(ref, "ORDER-1", confirmDeps(store, "DENIED"))).toEqual({ ok: false, reason: "not_held" });
    expect((await store.get(ref))?.state).toBe("AWAITING_BOND");
  });

  it("builds the pay page URL", () => {
    expect(payPageUrl("https://fianza.test/", ref)).toBe("https://fianza.test/pay/acme/widgets/42?sha=abc1234");
  });
});
