import { afterEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/cron/reconcile/route";
import { PayPalError } from "@/lib/paypal/client";
import { reconcile, type ReconcileDeps } from "@/lib/reconcile";
import { MemoryBondStore, type BondRecord } from "@/lib/store";

const now = new Date("2026-10-31T12:00:00Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();

function bonded(pr: number, placedHoursAgo: number, extra: Partial<BondRecord> = {}): BondRecord {
  return {
    ref: { owner: "acme", repo: "widgets", pr, headSha: "abc1234" },
    state: "BONDED",
    amountUsd: "5.00",
    authorizationId: `AUTH-${pr}`,
    history: [{ at: hoursAgo(placedHoursAgo), event: "AUTHORIZED" }],
    ...extra,
  };
}

async function setup(records: BondRecord[], over: Partial<ReconcileDeps> = {}) {
  const store = new MemoryBondStore();
  for (const r of records) await store.put(r);
  const calls: string[] = [];
  const deps: ReconcileDeps = {
    store,
    voidBond: async (id) => void calls.push(`void:${id}`),
    getAuthorization: async (id) => (calls.push(`get:${id}`), { status: "CREATED" }),
    now: () => now,
    ...over,
  };
  return { store, calls, deps };
}

const ref = (pr: number) => ({ owner: "acme", repo: "widgets", pr, headSha: "abc1234" });

describe("reconcile", () => {
  it("voids holds with no decision after 48 hours and leaves younger ones alone", async () => {
    const { store, calls, deps } = await setup([bonded(1, 49), bonded(2, 47)]);
    const result = await reconcile(deps);
    expect(result).toEqual({ checked: 1, voided: ["acme/widgets#1@abc1234"], synced: [], failed: [] });
    expect(calls).toEqual(["get:AUTH-1", "void:AUTH-1"]);
    expect((await store.get(ref(1)))?.state).toBe("VOIDED");
    expect((await store.get(ref(1)))?.history.at(-1)?.event).toBe("review_overdue_void");
    expect((await store.get(ref(2)))?.state).toBe("BONDED");
  });

  it("repairs a record whose webhook never arrived instead of voiding again", async () => {
    const { store, calls, deps } = await setup([bonded(1, 60)], { getAuthorization: async () => ({ status: "CAPTURED" }) });
    expect((await reconcile(deps)).synced).toEqual(["acme/widgets#1@abc1234"]);
    expect(calls).not.toContain("void:AUTH-1");
    expect((await store.get(ref(1)))?.state).toBe("CAPTURED");
  });

  it("on an unknown void outcome asks PayPal, and keeps the bond held if the void did not happen", async () => {
    let voided = false;
    const timeout = () => new PayPalError("void bond failed: timeout", undefined, undefined, undefined);
    const ok = await setup([bonded(1, 50)], {
      voidBond: async () => {
        voided = true;
        throw timeout();
      },
      getAuthorization: async () => ({ status: voided ? "VOIDED" : "CREATED" }),
    });
    expect((await reconcile(ok.deps)).voided).toHaveLength(1);

    const stuck = await setup([bonded(1, 50)], {
      voidBond: async () => {
        throw timeout();
      },
    });
    expect((await reconcile(stuck.deps)).failed).toHaveLength(1);
    expect((await stuck.store.get(ref(1)))?.state).toBe("BONDED");
  });

  it("only touches BONDED records", async () => {
    const { calls, deps } = await setup([bonded(1, 80, { state: "VOIDED" }), bonded(2, 80, { state: "CAPTURED" })]);
    expect((await reconcile(deps)).checked).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe("POST /api/cron/reconcile", () => {
  const original = process.env.CRON_SECRET;
  afterEach(() => {
    process.env.CRON_SECRET = original;
  });
  const call = (auth?: string) =>
    POST(new Request("https://fianza.test/api/cron/reconcile", { method: "POST", headers: auth ? { authorization: auth } : {} }));

  it("refuses to run without a configured secret or with the wrong one", async () => {
    delete process.env.CRON_SECRET;
    expect((await call("Bearer x")).status).toBe(503);
    process.env.CRON_SECRET = "s3cret-for-tests";
    expect((await call()).status).toBe(401);
    expect((await call("Bearer nope")).status).toBe(401);
  });

  it("runs with the right secret", async () => {
    process.env.CRON_SECRET = "s3cret-for-tests";
    const res = await call("Bearer s3cret-for-tests");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ checked: 0, voided: [] });
  });
});
