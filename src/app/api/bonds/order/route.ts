import { BondRefParams } from "@/lib/bond-status";
import { startBond } from "@/lib/bond-flow";
import { appConfig } from "@/lib/env";
import { createBondOrder } from "@/lib/paypal/bond";
import { PayPalError } from "@/lib/paypal/client";
import { bondStore } from "@/lib/store";

/** POST /api/bonds/order {owner, repo, pr, headSha} → {orderId}. Called by the bond page's button. */
export async function POST(request: Request) {
  const parsed = BondRefParams.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid_request" }, { status: 400 });
  const { APP_BASE_URL, BOND_AMOUNT_USD } = appConfig();
  try {
    const result = await startBond(parsed.data, {
      store: bondStore(),
      createOrder: createBondOrder,
      amountUsd: BOND_AMOUNT_USD,
      baseUrl: APP_BASE_URL,
      now: () => new Date(),
    });
    return result.ok ? Response.json({ orderId: result.orderId }) : Response.json({ error: result.reason }, { status: 409 });
  } catch (err) {
    const debugId = err instanceof PayPalError ? err.debugId : undefined;
    console.error("create bond order failed", debugId, err instanceof Error ? err.message : err);
    return Response.json({ error: "paypal_unavailable", debugId }, { status: 502 });
  }
}
