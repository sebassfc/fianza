import { z } from "zod";
import { BondRefParams } from "@/lib/bond-status";
import { confirmBond } from "@/lib/bond-flow";
import { authorizeBond } from "@/lib/paypal/bond";
import { PayPalError } from "@/lib/paypal/client";
import { bondStore } from "@/lib/store";

const Body = BondRefParams.extend({ orderId: z.string().min(1).max(64) });

/** POST /api/bonds/authorize {owner, repo, pr, headSha, orderId}: places the hold after the buyer approves. */
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid_request" }, { status: 400 });
  const { orderId, ...ref } = parsed.data;
  try {
    const result = await confirmBond(ref, orderId, { store: bondStore(), authorize: (id, r) => authorizeBond(id, r), now: () => new Date() });
    return result.ok ? Response.json(result) : Response.json({ error: result.reason }, { status: 409 });
  } catch (err) {
    const debugId = err instanceof PayPalError ? err.debugId : undefined;
    console.error("authorize bond failed", debugId, err instanceof Error ? err.message : err);
    return Response.json({ error: "paypal_unavailable", debugId }, { status: 502 });
  }
}
