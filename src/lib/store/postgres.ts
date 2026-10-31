import { bondLabel } from "@/lib/paypal/bond";
import type { BondState } from "@/lib/policy";
import { bondKey, type BondRecord, type BondStore, type EventLedger, type RepoStats } from "./index";

/** The two calls the stores need; node-postgres in production, PGlite in tests. */
export interface Sql {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(text: string): Promise<unknown>;
}

export const SCHEMA = `
create table if not exists fianza_bonds (
  key text primary key,
  label text not null,
  owner_repo text not null,
  state text not null,
  updated_at timestamptz,
  record jsonb not null
);
create index if not exists fianza_bonds_label on fianza_bonds (label);
create index if not exists fianza_bonds_repo on fianza_bonds (owner_repo);
create index if not exists fianza_bonds_state on fianza_bonds (state, updated_at desc);
create table if not exists fianza_events (id text primary key, at timestamptz not null default now());
`;

/** Runs the idempotent schema once, before the first query. */
export function withSchema(sql: Sql): Sql {
  let ready: Promise<unknown> | undefined;
  const init = () => (ready ??= sql.exec(SCHEMA).catch((err) => ((ready = undefined), Promise.reject(err))));
  return {
    query: async (text, params) => (await init(), sql.query(text, params)),
    exec: async (text) => (await init(), sql.exec(text)),
  };
}

const ownerRepo = (owner: string, repo: string) => `${owner}/${repo}`.toLowerCase();

/** Same contract as MemoryBondStore; the record itself is stored whole as JSONB. */
export class PgBondStore implements BondStore {
  constructor(private readonly sql: Sql) {}

  async get(ref: BondRecord["ref"]) {
    const { rows } = await this.sql.query<{ record: BondRecord }>("select record from fianza_bonds where key = $1", [bondKey(ref)]);
    return rows[0]?.record ?? null;
  }

  async getByLabel(label: string) {
    const { rows } = await this.sql.query<{ record: BondRecord }>("select record from fianza_bonds where label = $1 limit 1", [label]);
    return rows[0]?.record ?? null;
  }

  async put(record: BondRecord) {
    await this.sql.query(
      `insert into fianza_bonds (key, label, owner_repo, state, updated_at, record) values ($1, $2, $3, $4, $5, $6::jsonb)
       on conflict (key) do update set label = excluded.label, state = excluded.state, updated_at = excluded.updated_at, record = excluded.record`,
      [bondKey(record.ref), bondLabel(record.ref), ownerRepo(record.ref.owner, record.ref.repo), record.state, record.history.at(-1)?.at ?? null, JSON.stringify(record)],
    );
  }

  async list({ limit = 50, state }: { limit?: number; state?: BondState } = {}) {
    const { rows } = await this.sql.query<{ record: BondRecord }>(
      "select record from fianza_bonds where ($1::text is null or state = $1) order by updated_at desc nulls last limit $2",
      [state ?? null, limit],
    );
    return rows.map((r) => r.record);
  }

  async repoStats(owner: string, repo: string): Promise<RepoStats> {
    const { rows } = await this.sql.query<{ bonds: number; forfeits: number }>(
      `select count(*) filter (where state <> 'AWAITING_BOND')::int as bonds, count(*) filter (where state = 'CAPTURED')::int as forfeits
       from fianza_bonds where owner_repo = $1`,
      [ownerRepo(owner, repo)],
    );
    return { bonds: rows[0]?.bonds ?? 0, forfeits: rows[0]?.forfeits ?? 0 };
  }
}

export class PgEventLedger implements EventLedger {
  constructor(private readonly sql: Sql) {}

  async has(eventId: string) {
    return (await this.sql.query("select 1 from fianza_events where id = $1", [eventId])).rows.length > 0;
  }

  async add(eventId: string) {
    await this.sql.query("insert into fianza_events (id) values ($1) on conflict do nothing", [eventId]);
  }
}
