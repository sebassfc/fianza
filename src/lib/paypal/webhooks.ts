import { createPublicKey, createVerify, X509Certificate } from "node:crypto";
import { crc32 } from "node:zlib";

/**
 * Self-verification of PayPal webhooks (developer.paypal.com/api/rest/webhooks/rest):
 * the signed string is `transmissionId|transmissionTime|webhookId|crc32(raw body)`, signed with
 * SHA256withRSA by the certificate at `paypal-cert-url`. It works for simulator events too
 * (webhook id `WEBHOOK_ID`), which the verify-webhook-signature postback cannot check.
 */
export type WebhookHeaders = {
  transmissionId: string;
  transmissionTime: string;
  transmissionSig: string;
  certUrl: string;
  authAlgo: string;
};

export function readWebhookHeaders(h: Headers): WebhookHeaders | null {
  const get = (name: string) => h.get(name) ?? "";
  const out = {
    transmissionId: get("paypal-transmission-id"),
    transmissionTime: get("paypal-transmission-time"),
    transmissionSig: get("paypal-transmission-sig"),
    certUrl: get("paypal-cert-url"),
    authAlgo: get("paypal-auth-algo"),
  };
  return Object.values(out).every(Boolean) ? out : null;
}

/** CRC32 of the exact bytes PayPal sent. Never parse and re-serialize the body first. */
export function signedMessage(h: Pick<WebhookHeaders, "transmissionId" | "transmissionTime">, webhookId: string, rawBody: string | Uint8Array): string {
  const bytes = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  return `${h.transmissionId}|${h.transmissionTime}|${webhookId}|${crc32(bytes)}`;
}

const CERT_HOSTS = new Set(["api.paypal.com", "api.sandbox.paypal.com", "api-m.paypal.com", "api-m.sandbox.paypal.com"]);

/** Only PayPal's own certificate endpoint is trusted; otherwise anyone could sign with their own key. */
export function isPayPalCertUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && CERT_HOSTS.has(u.hostname) && u.pathname.startsWith("/v1/notifications/certs/");
  } catch {
    return false;
  }
}

export type CertLoader = (url: string) => Promise<string>;

const certCache = new Map<string, string>();

/** Downloads, validates and caches the signing certificate, as the PayPal guide recommends. */
export const loadPayPalCert: CertLoader = async (url) => {
  if (!isPayPalCertUrl(url)) throw new Error("untrusted certificate URL");
  const cached = certCache.get(url);
  if (cached) return cached;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`certificate download failed: ${res.status}`);
  const pem = await res.text();
  const cert = new X509Certificate(pem);
  const now = Date.now();
  if (now < Date.parse(cert.validFrom) || now > Date.parse(cert.validTo)) throw new Error("certificate is not currently valid");
  certCache.set(url, pem);
  return pem;
};

export type Verification =
  | { ok: true }
  | { ok: false; reason: "missing_headers" | "unsupported_algorithm" | "untrusted_cert_url" | "cert_unavailable" | "bad_signature" };

export async function verifyWebhook(
  rawBody: string | Uint8Array,
  headers: Headers,
  webhookId: string,
  loadCert: CertLoader = loadPayPalCert,
): Promise<Verification> {
  const h = readWebhookHeaders(headers);
  if (!h) return { ok: false, reason: "missing_headers" };
  if (h.authAlgo !== "SHA256withRSA") return { ok: false, reason: "unsupported_algorithm" };
  if (!isPayPalCertUrl(h.certUrl)) return { ok: false, reason: "untrusted_cert_url" };

  let pem: string;
  try {
    pem = await loadCert(h.certUrl);
  } catch {
    return { ok: false, reason: "cert_unavailable" };
  }
  try {
    const verifier = createVerify("SHA256");
    verifier.update(signedMessage(h, webhookId, rawBody));
    return verifier.verify(createPublicKey(pem), Buffer.from(h.transmissionSig, "base64")) ? { ok: true } : { ok: false, reason: "bad_signature" };
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
}
