import { Pool } from "pg";
import { bondLabel, type BondRef } from "@/lib/paypal/bond";
import type { BondState, Recommendation } from "@/lib/policy";
import { PgBondStore, PgEventLedger, withSchema, type Sql } from "./postgres";

/** One bond, pinned to one exact diff: a new head SHA needs a new bond. */
export type BondRecord = {
  ref: BondRef;
  state: BondState;
  amountUsd: string;
  orderId?: string;
  authorizationId?: string;
  captureId?: string;
  /** When PayPal's authorization stops being capturable (29 days, honor period 3). */
  authorizationExpiresAt?: string;
  recommendation?: Recommendation;
  history: { at: string; event: string; note?: string }[];
};

export type RepoStats = { bonds: number; forfeits: number };

/** Storage seam. The in-memory store backs tests and local dev; Postgres replaces it on Render. */
export interface BondStore {
  get(ref: BondRef): Promise<BondRecord | null>;
  /** Webhooks only carry the order's custom_id, which is `bondLabel(ref)`. */
  getByLabel(label: string): Promise<BondRecord | null>;
  put(record: BondRecord): Promise<void>;
  repoStats(owner: string, repo: string): Promise<RepoStats>;
  /** Most recently updated first, optionally only bonds in one state. */
  list(opts?: { limit?: number; state?: BondState }): Promise<BondRecord[]>;
}

/** Webhook event ids already applied. PayPal retries for 3 days, so delivery is at-least-once. */
export interface EventLedger {
  has(eventId: string): Promise<boolean>;
  add(eventId: string): Promise<void>;
}

export class MemoryEventLedger implements EventLedger {
  private readonly ids = new Set<string>();
  async has(eventId: string) {
    return this.ids.has(eventId);
  }
  async add(eventId: string) {
    this.ids.add(eventId);
  }
}

export function bondKey(ref: BondRef): string {
  return `${ref.owner}/${ref.repo}#${ref.pr}@${ref.headSha}`.toLowerCase();
}

export class MemoryBondStore implements BondStore {
  private readonly records = new Map<string, BondRecord>();

  async get(ref: BondRef) {
    const r = this.records.get(bondKey(ref));
    return r ? structuredClone(r) : null;
  }

  async getByLabel(label: string) {
    for (const r of this.records.values()) if (bondLabel(r.ref) === label) return structuredClone(r);
    return null;
  }

  async put(record: BondRecord) {
    this.records.set(bondKey(record.ref), structuredClone(record));
  }

  async list({ limit = 50, state }: { limit?: number; state?: BondState } = {}) {
    const lastAt = (r: BondRecord) => r.history.at(-1)?.at ?? "";
    return [...this.records.values()]
      .filter((r) => !state || r.state === state)
      .sort((a, b) => lastAt(b).localeCompare(lastAt(a)))
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }

  async repoStats(owner: string, repo: string): Promise<RepoStats> {
    const prefix = `${owner}/${repo}#`.toLowerCase();
    let bonds = 0;
    let forfeits = 0;
    for (const [key, r] of this.records) {
      if (!key.startsWith(prefix) || r.state === "AWAITING_BOND") continue;
      bonds++;
      if (r.state === "CAPTURED") forfeits++;
    }
    return { bonds, forfeits };
  }
}

// One store per server process; survives Next.js dev hot reloads.
const globalStore = globalThis as unknown as { __fianzaStore?: BondStore; __fianzaLedger?: EventLedger; __fianzaSql?: Sql };

/** Postgres when DATABASE_URL is set (Render), otherwise memory (tests, local dev). */
function sql(): Sql | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  if (!globalStore.__fianzaSql) {
    const pool = new Pool({ connectionString: url, max: 5 });
    // A hosted Postgres that scales to zero drops idle connections; unhandled, that error kills the process.
    pool.on("error", (err) => console.error("postgres idle client error:", err.message));
    globalStore.__fianzaSql = withSchema({ query: async (text, params) => ({ rows: (await pool.query(text, params)).rows as never[] }), exec: (text) => pool.query(text) });
  }
  return globalStore.__fianzaSql;
}

export function bondStore(): BondStore {
  const db = sql();
  globalStore.__fianzaStore ??= db ? new PgBondStore(db) : new MemoryBondStore();
  return globalStore.__fianzaStore;
}

export function eventLedger(): EventLedger {
  const db = sql();
  globalStore.__fianzaLedger ??= db ? new PgEventLedger(db) : new MemoryEventLedger();
  return globalStore.__fianzaLedger;
}
