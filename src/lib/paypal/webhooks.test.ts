import { createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { isPayPalCertUrl, signedMessage, verifyWebhook } from "./webhooks";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const certUrl = "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-ab66f33d";
const body = JSON.stringify({ id: "WH-1", event_type: "PAYMENT.AUTHORIZATION.CREATED", resource: { id: "AUTH-1" } });

function signedHeaders(raw: string, webhookId: string, overrides: Record<string, string> = {}) {
  const base = { transmissionId: "db49fb10-1343-11ef-ac58-e32457403f67", transmissionTime: "2026-10-29T18:00:00Z" };
  const sig = createSign("SHA256").update(signedMessage(base, webhookId, raw)).sign(privateKey, "base64");
  return new Headers({
    "paypal-transmission-id": base.transmissionId,
    "paypal-transmission-time": base.transmissionTime,
    "paypal-transmission-sig": sig,
    "paypal-cert-url": certUrl,
    "paypal-auth-algo": "SHA256withRSA",
    ...overrides,
  });
}

const loader = async () => publicPem;

describe("signedMessage", () => {
  it("uses the decimal CRC32 of the raw body", () => {
    expect(signedMessage({ transmissionId: "t", transmissionTime: "s" }, "W", "hello")).toBe("t|s|W|907060870");
  });
});

describe("isPayPalCertUrl", () => {
  it.each([
    [certUrl, true],
    ["https://api.paypal.com/v1/notifications/certs/CERT-x", true],
    ["http://api.sandbox.paypal.com/v1/notifications/certs/CERT-x", false],
    ["https://api.sandbox.paypal.com.evil.test/v1/notifications/certs/CERT-x", false],
    ["https://evil.test/v1/notifications/certs/CERT-x", false],
    ["https://api.sandbox.paypal.com/other", false],
    ["not a url", false],
  ])("%s → %s", (url, ok) => expect(isPayPalCertUrl(url)).toBe(ok));
});

describe("verifyWebhook", () => {
  it("accepts a correctly signed event", async () => {
    expect(await verifyWebhook(body, signedHeaders(body, "WH-APP"), "WH-APP", loader)).toEqual({ ok: true });
  });

  it("accepts simulator events signed for WEBHOOK_ID", async () => {
    expect(await verifyWebhook(body, signedHeaders(body, "WEBHOOK_ID"), "WEBHOOK_ID", loader)).toEqual({ ok: true });
  });

  it("rejects a body changed by one byte, even re-serialized JSON", async () => {
    const headers = signedHeaders(body, "WH-APP");
    const reserialized = JSON.stringify(JSON.parse(body), null, 1);
    expect(await verifyWebhook(reserialized, headers, "WH-APP", loader)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects an event signed for another webhook id", async () => {
    expect(await verifyWebhook(body, signedHeaders(body, "OTHER"), "WH-APP", loader)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("never downloads a certificate from outside PayPal", async () => {
    const spy = vi.fn(loader);
    const headers = signedHeaders(body, "WH-APP", { "paypal-cert-url": "https://evil.test/v1/notifications/certs/CERT-x" });
    expect(await verifyWebhook(body, headers, "WH-APP", spy)).toEqual({ ok: false, reason: "untrusted_cert_url" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects missing headers, other algorithms and an unreachable certificate", async () => {
    expect(await verifyWebhook(body, new Headers(), "WH-APP", loader)).toEqual({ ok: false, reason: "missing_headers" });
    const md5 = signedHeaders(body, "WH-APP", { "paypal-auth-algo": "MD5withRSA" });
    expect(await verifyWebhook(body, md5, "WH-APP", loader)).toEqual({ ok: false, reason: "unsupported_algorithm" });
    const down = async () => {
      throw new Error("timeout");
    };
    expect(await verifyWebhook(body, signedHeaders(body, "WH-APP"), "WH-APP", down)).toEqual({ ok: false, reason: "cert_unavailable" });
  });
});
