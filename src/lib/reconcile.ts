import { EXPRESS_REVIEW_HOURS } from "@/lib/bond-status";
import { PayPalError } from "@/lib/paypal/client";
import type { BondRef } from "@/lib/paypal/bond";
import { stateForAuthorization } from "@/lib/paypal/webhook-events";
import type { BondRecord, BondStore } from "@/lib/store";

export type ReconcileDeps = {
  store: BondStore;
  voidBond: (authorizationId: string, ref: BondRef) => Promise<void>;
  getAuthorization: (authorizationId: string) => Promise<{ status: string }>;
  now: () => Date;
};

export type ReconcileResult = { checked: number; voided: string[]; synced: string[]; failed: string[] };

const label = (r: BondRecord) => `${r.ref.owner}/${r.ref.repo}#${r.ref.pr}@${r.ref.headSha}`;

/** When the hold was placed: the AUTHORIZED entry, from the bond page or the webhook, whichever came first. */
export function bondedAt(record: BondRecord): Date | null {
  const at = record.history.find((h) => h.event === "AUTHORIZED")?.at;
  return at ? new Date(at) : null;
}

/**
 * Keeps the review guarantee: a hold nobody decided on within EXPRESS_REVIEW_HOURS is voided, so the
 * operator pays $0 when the maintainer does not deliver. PayPal's status is read first, which also
 * repairs records whose webhook never arrived. Safe to run as often as wanted: the void carries a
 * deterministic PayPal-Request-Id and an unknown outcome is looked up, never blindly retried.
 */
export async function reconcile(deps: ReconcileDeps): Promise<ReconcileResult> {
  const result: ReconcileResult = { checked: 0, voided: [], synced: [], failed: [] };
  const deadline = deps.now().getTime() - EXPRESS_REVIEW_HOURS * 3_600_000;

  for (const record of await deps.store.list({ state: "BONDED", limit: 500 })) {
    const placed = bondedAt(record);
    const authId = record.authorizationId;
    if (!authId || !placed || placed.getTime() > deadline) continue;
    result.checked++;

    const save = (state: BondRecord["state"], event: string, note: string) =>
      deps.store.put({ ...record, state, history: [...record.history, { at: deps.now().toISOString(), event, note }] });

    try {
      const status = (await deps.getAuthorization(authId)).status;
      const actual = stateForAuthorization(status);
      if (actual && actual !== "BONDED") {
        await save(actual, "reconciled", `PayPal reports ${status}`);
        result.synced.push(label(record));
        continue;
      }
      try {
        await deps.voidBond(authId, record.ref);
      } catch (err) {
        if (!(err instanceof PayPalError && err.outcomeUnknown && (await deps.getAuthorization(authId)).status === "VOIDED")) throw err;
      }
      await save("VOIDED", "review_overdue_void", `no maintainer decision within ${EXPRESS_REVIEW_HOURS}h`);
      result.voided.push(label(record));
    } catch {
      // Left BONDED; the next run tries again with the same request id.
      result.failed.push(label(record));
    }
  }
  return result;
}
