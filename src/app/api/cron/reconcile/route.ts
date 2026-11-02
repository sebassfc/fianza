import { createHash, timingSafeEqual } from "node:crypto";
import { getAuthorization, voidBond } from "@/lib/paypal/bond";
import { reconcile } from "@/lib/reconcile";
import { bondStore } from "@/lib/store";

const digest = (s: string) => createHash("sha256").update(s).digest();

/** POST /api/cron/reconcile with `Authorization: Bearer $CRON_SECRET`. Called hourly by .github/workflows/reconcile.yml. */
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  const given = request.headers.get("authorization") ?? "";
  if (!timingSafeEqual(digest(given), digest(`Bearer ${secret}`))) return Response.json({ error: "unauthorized" }, { status: 401 });

  const result = await reconcile({ store: bondStore(), voidBond, getAuthorization, now: () => new Date() });
  return Response.json(result);
}
