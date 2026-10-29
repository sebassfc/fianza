import type { BondRef } from "@/lib/paypal/bond";
import type { BondState, Recommendation } from "@/lib/policy";

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
  put(record: BondRecord): Promise<void>;
  repoStats(owner: string, repo: string): Promise<RepoStats>;
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

  async put(record: BondRecord) {
    this.records.set(bondKey(record.ref), structuredClone(record));
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
const globalStore = globalThis as unknown as { __fianzaStore?: BondStore };

export function bondStore(): BondStore {
  globalStore.__fianzaStore ??= new MemoryBondStore();
  return globalStore.__fianzaStore;
}
