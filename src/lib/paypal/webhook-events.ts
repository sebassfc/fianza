import { z } from "zod";
import { canTransition, nextState, type BondEvent, type BondState } from "@/lib/policy";
import type { BondRecord, BondStore, EventLedger } from "@/lib/store";

export const WebhookEvent = z.object({
  id: z.string().min(1),
  event_type: z.string(),
  resource: z
    .object({
      id: z.string(),
      status: z.string().optional(),
      custom_id: z.string().optional(),
      supplementary_data: z.object({ related_ids: z.object({ authorization_id: z.string().optional() }).partial() }).partial().optional(),
      links: z.array(z.object({ href: z.string(), rel: z.string() })).optional(),
    })
    .loose(),
});
export type WebhookEvent = z.infer<typeof WebhookEvent>;

const AUTHORIZATION_EVENTS = new Set(["PAYMENT.AUTHORIZATION.CREATED", "PAYMENT.AUTHORIZATION.VOIDED"]);
const CAPTURE_EVENTS = new Set(["PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.PENDING"]);
const REFUND_EVENTS = new Set(["PAYMENT.CAPTURE.REFUNDED"]);

/** Bond state implied by PayPal's own status. `null` means "nothing to change" (e.g. a declined capture). */
export function stateForAuthorization(status: string): BondState | null {
  switch (status) {
    case "CREATED":
    case "PENDING":
      return "BONDED";
    case "VOIDED":
    case "EXPIRED":
      return "VOIDED";
    case "CAPTURED":
    case "PARTIALLY_CAPTURED":
      return "CAPTURED";
    default:
      return null;
  }
}

export function stateForCapture(status: string): BondState | null {
  if (status === "REFUNDED" || status === "PARTIALLY_REFUNDED") return "REFUNDED";
  if (status === "COMPLETED") return "CAPTURED";
  return null;
}

const ALL_EVENTS: BondEvent[] = ["AUTHORIZED", "VOID", "CAPTURE", "REFUND"];

/** Shortest legal path between two states, so a late or out-of-order webhook still lands correctly. */
export function pathBetween(from: BondState, to: BondState): BondEvent[] | null {
  const queue: { state: BondState; path: BondEvent[] }[] = [{ state: from, path: [] }];
  const seen = new Set<BondState>([from]);
  while (queue.length) {
    const { state, path } = queue.shift()!;
    if (state === to) return path;
    for (const e of ALL_EVENTS) {
      if (!canTransition(state, e)) continue;
      const n = nextState(state, e);
      if (!seen.has(n)) {
        seen.add(n);
        queue.push({ state: n, path: [...path, e] });
      }
    }
  }
  return null;
}

/** For PAYMENT.CAPTURE.REFUNDED the resource is the refund; its "up" link points at the capture. */
function captureIdFromRefund(e: WebhookEvent): string | undefined {
  const up = e.resource.links?.find((l) => l.rel === "up")?.href;
  return up?.match(/\/captures\/([^/?]+)/)?.[1];
}

export type ApplyDeps = {
  store: BondStore;
  ledger: EventLedger;
  getAuthorization: (id: string) => Promise<{ status: string }>;
  getCapture: (id: string) => Promise<{ status: string }>;
  now: () => Date;
};

export type ApplyResult =
  | { outcome: "duplicate" | "ignored" | "unknown_bond" }
  | { outcome: "no_change"; state: BondState; note: string }
  | { outcome: "updated"; from: BondState; to: BondState; via: BondEvent[] };

/**
 * Applies one verified webhook. The event only says *something happened*: the bond moves to the state
 * PayPal reports on a fresh GET, never to what the event claims. If the GET fails the error propagates,
 * the event is not marked as processed and PayPal's retry gets another chance.
 */
export async function applyWebhook(event: WebhookEvent, deps: ApplyDeps): Promise<ApplyResult> {
  if (await deps.ledger.has(event.id)) return { outcome: "duplicate" };

  const kind = AUTHORIZATION_EVENTS.has(event.event_type)
    ? "authorization"
    : CAPTURE_EVENTS.has(event.event_type)
      ? "capture"
      : REFUND_EVENTS.has(event.event_type)
        ? "refund"
        : null;
  if (!kind) {
    await deps.ledger.add(event.id);
    return { outcome: "ignored" };
  }

  const record = event.resource.custom_id ? await deps.store.getByLabel(event.resource.custom_id) : null;
  if (!record) {
    await deps.ledger.add(event.id);
    return { outcome: "unknown_bond" };
  }

  let target: BondState | null;
  const updates: Partial<BondRecord> = {};
  if (kind === "authorization") {
    const auth = await deps.getAuthorization(event.resource.id);
    target = stateForAuthorization(auth.status);
    updates.authorizationId = event.resource.id;
  } else if (kind === "capture") {
    const authorizationId = event.resource.supplementary_data?.related_ids?.authorization_id ?? record.authorizationId;
    const auth = authorizationId ? await deps.getAuthorization(authorizationId) : { status: "" };
    target = stateForAuthorization(auth.status);
    if (target === "CAPTURED") updates.captureId = event.resource.id;
  } else {
    const captureId = captureIdFromRefund(event) ?? record.captureId;
    const capture = captureId ? await deps.getCapture(captureId) : { status: "" };
    target = stateForCapture(capture.status);
  }

  const at = deps.now().toISOString();
  const note = `${event.event_type} (${event.id})`;
  const path = target && target !== record.state ? pathBetween(record.state, target) : null;

  if (!target || target === record.state || !path) {
    const reason = !target ? "PayPal reports no state change" : target === record.state ? "already in this state" : `no legal path ${record.state} → ${target}`;
    await deps.store.put({ ...record, history: [...record.history, { at, event: "webhook_no_change", note: `${note}: ${reason}` }] });
    await deps.ledger.add(event.id);
    return { outcome: "no_change", state: record.state, note: reason };
  }

  await deps.store.put({
    ...record,
    ...updates,
    state: target,
    history: [...record.history, ...path.map((e) => ({ at, event: e, note }))],
  });
  await deps.ledger.add(event.id);
  return { outcome: "updated", from: record.state, to: target, via: path };
}
