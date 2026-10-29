import { describe, expect, it } from "vitest";
import { bondLabel } from "./bond";
import { applyWebhook, pathBetween, WebhookEvent, type ApplyDeps } from "./webhook-events";
import { MemoryBondStore, MemoryEventLedger, type BondRecord } from "@/lib/store";

const ref = { owner: "acme", repo: "widgets", pr: 42, headSha: "abc1234def56" };
const label = bondLabel(ref);

function setup(state: BondRecord["state"], paypal: { auth?: string; capture?: string } = {}) {
  const store = new MemoryBondStore();
  const ledger = new MemoryEventLedger();
  const calls: string[] = [];
  const deps: ApplyDeps = {
    store,
    ledger,
    getAuthorization: async (id) => {
      calls.push(`auth:${id}`);
      if (!paypal.auth) throw new Error("PayPal unavailable");
      return { status: paypal.auth };
    },
    getCapture: async (id) => {
      calls.push(`capture:${id}`);
      return { status: paypal.capture ?? "" };
    },
    now: () => new Date("2026-10-29T18:00:00Z"),
  };
  const ready = store.put({ ref, state, amountUsd: "5.00", authorizationId: state === "AWAITING_BOND" ? undefined : "AUTH-1", captureId: state === "CAPTURED" ? "CAP-1" : undefined, history: [] });
  return { store, ledger, deps, calls, ready };
}

const event = (type: string, resource: Record<string, unknown>, id = "WH-1") =>
  WebhookEvent.parse({ id, event_type: type, resource: { custom_id: label, ...resource } });

describe("pathBetween", () => {
  it("finds the legal path, or none", () => {
    expect(pathBetween("AWAITING_BOND", "VOIDED")).toEqual(["AUTHORIZED", "VOID"]);
    expect(pathBetween("AWAITING_BOND", "REFUNDED")).toEqual(["AUTHORIZED", "CAPTURE", "REFUND"]);
    expect(pathBetween("VOIDED", "CAPTURED")).toBeNull();
  });
});

describe("applyWebhook", () => {
  it("AUTHORIZATION.CREATED + PayPal says CREATED → BONDED", async () => {
    const s = setup("AWAITING_BOND", { auth: "CREATED" });
    await s.ready;
    const r = await applyWebhook(event("PAYMENT.AUTHORIZATION.CREATED", { id: "AUTH-1" }), s.deps);
    expect(r).toEqual({ outcome: "updated", from: "AWAITING_BOND", to: "BONDED", via: ["AUTHORIZED"] });
    expect((await s.store.get(ref))?.authorizationId).toBe("AUTH-1");
  });

  it("the same event delivered twice is applied once", async () => {
    const s = setup("AWAITING_BOND", { auth: "CREATED" });
    await s.ready;
    const e = event("PAYMENT.AUTHORIZATION.CREATED", { id: "AUTH-1" });
    await applyWebhook(e, s.deps);
    expect(await applyWebhook(e, s.deps)).toEqual({ outcome: "duplicate" });
    expect(s.calls).toEqual(["auth:AUTH-1"]);
  });

  it("out of order: VOIDED arrives before CREATED and still lands on VOIDED", async () => {
    const s = setup("AWAITING_BOND", { auth: "VOIDED" });
    await s.ready;
    const r = await applyWebhook(event("PAYMENT.AUTHORIZATION.VOIDED", { id: "AUTH-1" }, "WH-2"), s.deps);
    expect(r).toMatchObject({ outcome: "updated", to: "VOIDED", via: ["AUTHORIZED", "VOID"] });
    const late = await applyWebhook(event("PAYMENT.AUTHORIZATION.CREATED", { id: "AUTH-1" }, "WH-1"), s.deps);
    expect(late).toMatchObject({ outcome: "no_change", state: "VOIDED" });
  });

  it("trusts PayPal's GET, not the event: a CAPTURE.COMPLETED on a still-CREATED authorization changes nothing", async () => {
    const s = setup("BONDED", { auth: "CREATED" });
    await s.ready;
    const r = await applyWebhook(event("PAYMENT.CAPTURE.COMPLETED", { id: "CAP-1", supplementary_data: { related_ids: { authorization_id: "AUTH-1" } } }), s.deps);
    expect(r).toMatchObject({ outcome: "no_change", state: "BONDED" });
  });

  it("CAPTURE.COMPLETED confirmed by PayPal → CAPTURED with the capture id", async () => {
    const s = setup("BONDED", { auth: "CAPTURED" });
    await s.ready;
    await applyWebhook(event("PAYMENT.CAPTURE.COMPLETED", { id: "CAP-9", supplementary_data: { related_ids: { authorization_id: "AUTH-1" } } }), s.deps);
    expect(await s.store.get(ref)).toMatchObject({ state: "CAPTURED", captureId: "CAP-9" });
  });

  it("a declined capture keeps the bond held and logs why", async () => {
    const s = setup("BONDED", { auth: "CREATED" });
    await s.ready;
    const r = await applyWebhook(event("PAYMENT.CAPTURE.DENIED", { id: "CAP-1", supplementary_data: { related_ids: { authorization_id: "AUTH-1" } } }), s.deps);
    expect(r.outcome).toBe("no_change");
    expect((await s.store.get(ref))?.history.at(-1)?.event).toBe("webhook_no_change");
  });

  it("CAPTURE.REFUNDED follows the refund's link to the capture → REFUNDED", async () => {
    const s = setup("CAPTURED", { capture: "REFUNDED" });
    await s.ready;
    const refund = event("PAYMENT.CAPTURE.REFUNDED", {
      id: "REF-1",
      links: [{ rel: "up", href: "https://api.sandbox.paypal.com/v2/payments/captures/CAP-1" }],
    });
    expect(await applyWebhook(refund, s.deps)).toMatchObject({ outcome: "updated", to: "REFUNDED" });
    expect(s.calls).toEqual(["capture:CAP-1"]);
  });

  it("if PayPal cannot be reached the event is NOT marked, so PayPal's retry applies it later", async () => {
    const s = setup("AWAITING_BOND");
    await s.ready;
    const e = event("PAYMENT.AUTHORIZATION.CREATED", { id: "AUTH-1" });
    await expect(applyWebhook(e, s.deps)).rejects.toThrow(/unavailable/);
    expect(await s.ledger.has("WH-1")).toBe(false);
    expect((await s.store.get(ref))?.state).toBe("AWAITING_BOND");
  });

  it("ignores events it does not handle and bonds it does not know", async () => {
    const s = setup("BONDED", { auth: "CREATED" });
    await s.ready;
    expect(await applyWebhook(event("BILLING.SUBSCRIPTION.CREATED", { id: "X" }, "WH-7"), s.deps)).toEqual({ outcome: "ignored" });
    const stranger = WebhookEvent.parse({ id: "WH-8", event_type: "PAYMENT.AUTHORIZATION.CREATED", resource: { id: "AUTH-9", custom_id: "someone/else#1@0000" } });
    expect(await applyWebhook(stranger, s.deps)).toEqual({ outcome: "unknown_bond" });
  });
});
