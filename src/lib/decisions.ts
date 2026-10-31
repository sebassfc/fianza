import { PayPalError } from "@/lib/paypal/client";
import type { BondRef } from "@/lib/paypal/bond";
import { canCapture, type BondState, type CaptureCheck } from "@/lib/policy";
import type { BondRecord, BondStore } from "@/lib/store";

export type MaintainerAction = "accept" | "forfeit" | "appeal";

const ALIASES: Record<string, MaintainerAction> = {
  accept: "accept",
  aceptar: "accept",
  forfeit: "forfeit",
  cobrar: "forfeit",
  appeal: "appeal",
  apelar: "appeal",
};

/** `/fianza accept|forfeit|appeal` (or the Spanish aliases) on its own line in a PR comment. */
export function parseCommand(body: string): MaintainerAction | null {
  const m = body.match(/^\s*\/fianza\s+([a-z]+)\s*$/im);
  return m ? (ALIASES[m[1].toLowerCase()] ?? null) : null;
}

export type DecisionDeps = {
  store: BondStore;
  voidBond: (authorizationId: string, ref: BondRef) => Promise<void>;
  captureBond: (authorizationId: string, ref: BondRef) => Promise<{ captureId: string }>;
  refundBond: (captureId: string, ref: BondRef) => Promise<unknown>;
  getAuthorization: (authorizationId: string) => Promise<{ status: string }>;
  getCapture: (captureId: string) => Promise<{ status: string }>;
  forfeitsThisMonth: (owner: string, repo: string) => Promise<number>;
  monthlyForfeitCap: number;
  now: () => Date;
};

export type DecisionResult =
  | { ok: true; state: BondState; already?: true; recovered?: true }
  | { ok: false; reason: "not_maintainer" | "wrong_state" | "missing_payment_id" | Extract<CaptureCheck, { allowed: false }>["reason"] };

/**
 * Runs a maintainer's decision exactly once. Every PayPal call carries a deterministic PayPal-Request-Id
 * (see bond.ts); when a call fails with an unknown outcome (timeout or 5xx) the payment is looked up
 * before anything else happens, so a retry can never charge twice and a success is never reported as a failure.
 */
export async function decide(
  record: BondRecord,
  action: MaintainerAction,
  actor: { login: string; isMaintainer: boolean },
  deps: DecisionDeps,
): Promise<DecisionResult> {
  if (!actor.isMaintainer) return { ok: false, reason: "not_maintainer" };
  const done: Record<MaintainerAction, BondState> = { accept: "VOIDED", forfeit: "CAPTURED", appeal: "REFUNDED" };
  if (record.state === done[action]) return { ok: true, state: record.state, already: true };

  const save = async (state: BondState, extra: Partial<BondRecord>, recovered: boolean) => {
    await deps.store.put({
      ...record,
      ...extra,
      state,
      history: [...record.history, { at: deps.now().toISOString(), event: `maintainer_${action}`, note: `by @${actor.login}${recovered ? " (recovered after unknown outcome)" : ""}` }],
    });
    return recovered ? ({ ok: true, state, recovered: true } as const) : ({ ok: true, state } as const);
  };

  /** Runs a money call; on an unknown outcome asks PayPal whether it actually happened. */
  const once = async <T>(call: () => Promise<T>, happened: () => Promise<boolean>): Promise<{ value?: T; recovered: boolean }> => {
    try {
      return { value: await call(), recovered: false };
    } catch (err) {
      if (err instanceof PayPalError && err.outcomeUnknown && (await happened())) return { recovered: true };
      throw err;
    }
  };

  switch (action) {
    case "accept": {
      if (record.state !== "BONDED") return { ok: false, reason: "wrong_state" };
      const authId = record.authorizationId;
      if (!authId) return { ok: false, reason: "missing_payment_id" };
      const r = await once(() => deps.voidBond(authId, record.ref), async () => (await deps.getAuthorization(authId)).status === "VOIDED");
      return save("VOIDED", {}, r.recovered);
    }
    case "forfeit": {
      const check = canCapture({
        state: record.state,
        recommendation: record.recommendation ?? "REVIEW",
        maintainerConfirmed: true,
        forfeitsThisMonth: await deps.forfeitsThisMonth(record.ref.owner, record.ref.repo),
        monthlyForfeitCap: deps.monthlyForfeitCap,
      });
      if (!check.allowed) return { ok: false, reason: check.reason };
      const authId = record.authorizationId;
      if (!authId) return { ok: false, reason: "missing_payment_id" };
      const r = await once(() => deps.captureBond(authId, record.ref), async () => (await deps.getAuthorization(authId)).status === "CAPTURED");
      // On a recovered capture the id arrives later with the PAYMENT.CAPTURE.COMPLETED webhook.
      return save("CAPTURED", r.value ? { captureId: r.value.captureId } : {}, r.recovered);
    }
    case "appeal": {
      if (record.state !== "CAPTURED") return { ok: false, reason: "wrong_state" };
      const captureId = record.captureId;
      if (!captureId) return { ok: false, reason: "missing_payment_id" };
      const r = await once(() => deps.refundBond(captureId, record.ref), async () => /REFUNDED/.test((await deps.getCapture(captureId)).status));
      return save("REFUNDED", {}, r.recovered);
    }
  }
}
