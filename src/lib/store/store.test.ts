import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { bondLabel } from "@/lib/paypal/bond";
import { MemoryBondStore, MemoryEventLedger, type BondRecord, type BondStore, type EventLedger } from "./index";
import { PgBondStore, PgEventLedger, withSchema, type Sql } from "./postgres";

function pglite(): Sql {
  const db = new PGlite();
  return withSchema({ query: (text, params) => db.query(text, params), exec: (text) => db.exec(text) });
}

const ref = { owner: "Acme", repo: "widgets", pr: 42, headSha: "abc1234def56" };
const record = (pr: number, state: BondRecord["state"], at?: string, extra: Partial<BondRecord> = {}): BondRecord => ({
  ref: { ...ref, pr },
  state,
  amountUsd: "5.00",
  history: at ? [{ at, event: "AUTHORIZED", note: "AUTH-1" }] : [],
  ...extra,
});

// One PGlite per run: starting the WASM Postgres takes seconds, emptying its tables takes milliseconds.
let sql: Sql;
beforeAll(async () => {
  sql = pglite();
  await sql.exec("select 1");
}, 60_000);

const stores: [string, () => Promise<{ store: BondStore; ledger: EventLedger }>][] = [
  ["memory", async () => ({ store: new MemoryBondStore(), ledger: new MemoryEventLedger() })],
  [
    "postgres",
    async () => {
      await sql.exec("truncate fianza_bonds, fianza_events");
      return { store: new PgBondStore(sql), ledger: new PgEventLedger(sql) };
    },
  ],
];

describe.each(stores)("%s store", (_name, make) => {
  it("round-trips a record, looks it up by key, case-insensitively, and by PayPal label", async () => {
    const { store } = await make();
    const r = record(42, "BONDED", "2026-10-31T10:00:00.000Z", { authorizationId: "AUTH-1", authorizationExpiresAt: "2026-11-29T10:00:00Z" });
    await store.put(r);
    expect(await store.get(r.ref)).toEqual(r);
    expect(await store.get({ ...r.ref, owner: "acme" })).toEqual(r);
    expect(await store.getByLabel(bondLabel(r.ref))).toEqual(r);
    expect(await store.get({ ...r.ref, headSha: "fff0000" })).toBeNull();
  });

  it("upserts: a second put replaces the state and history", async () => {
    const { store } = await make();
    await store.put(record(42, "BONDED", "2026-10-31T10:00:00.000Z"));
    const voided = record(42, "VOIDED", "2026-10-31T11:00:00.000Z");
    await store.put(voided);
    expect(await store.get(voided.ref)).toEqual(voided);
    expect(await store.list()).toHaveLength(1);
  });

  it("lists newest first, filters by state, and respects the limit", async () => {
    const { store } = await make();
    await store.put(record(1, "BONDED", "2026-10-29T10:00:00.000Z"));
    await store.put(record(2, "VOIDED", "2026-10-29T12:00:00.000Z"));
    await store.put(record(3, "BONDED", "2026-10-29T11:00:00.000Z"));
    await store.put(record(4, "AWAITING_BOND"));
    expect((await store.list()).map((r) => r.ref.pr)).toEqual([2, 3, 1, 4]);
    expect((await store.list({ state: "BONDED" })).map((r) => r.ref.pr)).toEqual([3, 1]);
    expect((await store.list({ limit: 1 })).map((r) => r.ref.pr)).toEqual([2]);
  });

  it("counts posted bonds and forfeits per repo", async () => {
    const { store } = await make();
    await store.put(record(1, "BONDED", "2026-10-29T10:00:00.000Z"));
    await store.put(record(2, "CAPTURED", "2026-10-29T10:00:00.000Z"));
    await store.put(record(3, "AWAITING_BOND"));
    await store.put({ ...record(4, "CAPTURED", "2026-10-29T10:00:00.000Z"), ref: { ...ref, pr: 4, repo: "other" } });
    expect(await store.repoStats("acme", "widgets")).toEqual({ bonds: 2, forfeits: 1 });
    expect(await store.repoStats("nobody", "nothing")).toEqual({ bonds: 0, forfeits: 0 });
  });

  it("remembers applied webhook events, once", async () => {
    const { ledger } = await make();
    expect(await ledger.has("WH-1")).toBe(false);
    await ledger.add("WH-1");
    await ledger.add("WH-1");
    expect(await ledger.has("WH-1")).toBe(true);
  });
});
