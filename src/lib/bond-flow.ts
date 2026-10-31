import type { Authorization, BondRef, CreatedBond } from "@/lib/paypal/bond";
import type { BondRecord, BondStore } from "@/lib/store";

export type StartDeps = {
  store: BondStore;
  createOrder: (ref: BondRef, urls: { returnUrl: string; cancelUrl: string }) => Promise<CreatedBond>;
  amountUsd: string;
  baseUrl: string;
  now: () => Date;
};

export type StartResult = { ok: true; orderId: string } | { ok: false; reason: `already_${Lowercase<Exclude<BondRecord["state"], "AWAITING_BOND">>}` };

export function payPageUrl(baseUrl: string, ref: BondRef, extra = ""): string {
  const base = baseUrl.replace(/\/$/, "");
  return `${base}/pay/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/${ref.pr}?sha=${ref.headSha}${extra}`;
}

/**
 * Creates the PayPal order (intent AUTHORIZE) only when a human clicks the button on the bond page.
 * Re-clicking reuses the deterministic PayPal-Request-Id, so PayPal returns the same order.
 */
export async function startBond(ref: BondRef, deps: StartDeps): Promise<StartResult> {
  const existing = await deps.store.get(ref);
  if (existing && existing.state !== "AWAITING_BOND") {
    const state = existing.state.toLowerCase() as Lowercase<Exclude<BondRecord["state"], "AWAITING_BOND">>;
    return { ok: false, reason: `already_${state}` };
  }
  const order = await deps.createOrder(ref, {
    returnUrl: payPageUrl(deps.baseUrl, ref, "&approved=1"),
    cancelUrl: payPageUrl(deps.baseUrl, ref, "&cancelled=1"),
  });
  const at = deps.now().toISOString();
  await deps.store.put({
    ref,
    state: "AWAITING_BOND",
    amountUsd: deps.amountUsd,
    orderId: order.orderId,
    history: [...(existing?.history ?? []), { at, event: "order_created", note: order.orderId }],
  });
  return { ok: true, orderId: order.orderId };
}

export type ConfirmDeps = {
  store: BondStore;
  authorize: (orderId: string, ref: BondRef) => Promise<Authorization>;
  now: () => Date;
};

export type ConfirmResult =
  | { ok: true; authorizationId: string; already?: true }
  | { ok: false; reason: "unknown_order" | "order_mismatch" | "not_held" };

/** Runs after the buyer approves in PayPal: places the hold. Nothing is charged. */
export async function confirmBond(ref: BondRef, orderId: string, deps: ConfirmDeps): Promise<ConfirmResult> {
  const record = await deps.store.get(ref);
  if (!record) return { ok: false, reason: "unknown_order" };
  if (record.orderId !== orderId) return { ok: false, reason: "order_mismatch" };
  if (record.state === "BONDED" && record.authorizationId) return { ok: true, authorizationId: record.authorizationId, already: true };

  const auth = await deps.authorize(orderId, ref);
  if (auth.status !== "CREATED" && auth.status !== "PENDING") return { ok: false, reason: "not_held" };
  await deps.store.put({
    ...record,
    state: "BONDED",
    authorizationId: auth.authorizationId,
    authorizationExpiresAt: auth.expirationTime,
    history: [...record.history, { at: deps.now().toISOString(), event: "AUTHORIZED", note: auth.authorizationId }],
  });
  return { ok: true, authorizationId: auth.authorizationId };
}
