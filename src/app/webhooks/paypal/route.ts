import { getAuthorization, getCapture } from "@/lib/paypal/bond";
import { applyWebhook, WebhookEvent } from "@/lib/paypal/webhook-events";
import { verifyWebhook } from "@/lib/paypal/webhooks";
import { bondStore, eventLedger } from "@/lib/store";

/**
 * POST /webhooks/paypal. Verify the signature over the raw bytes, then apply the event against a fresh GET.
 * Non-2xx answers make PayPal retry (up to 25 times over 3 days), which is what we want on transient errors.
 */
export async function POST(request: Request) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) return Response.json({ error: "PAYPAL_WEBHOOK_ID is not configured" }, { status: 503 });

  const raw = new Uint8Array(await request.arrayBuffer());
  const verification = await verifyWebhook(raw, request.headers, webhookId);
  if (!verification.ok) return Response.json({ error: "invalid_signature", reason: verification.reason }, { status: 400 });

  const parsed = WebhookEvent.safeParse(JSON.parse(new TextDecoder().decode(raw)));
  if (!parsed.success) return Response.json({ error: "unexpected_event_shape" }, { status: 400 });

  try {
    const result = await applyWebhook(parsed.data, {
      store: bondStore(),
      ledger: eventLedger(),
      getAuthorization,
      getCapture,
      now: () => new Date(),
    });
    return Response.json(result);
  } catch (err) {
    console.error("webhook apply failed", parsed.data.id, err instanceof Error ? err.message : err);
    return Response.json({ error: "temporary_failure" }, { status: 500 });
  }
}
