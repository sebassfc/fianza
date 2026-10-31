import { createHmac, createSign, timingSafeEqual } from "node:crypto";

/** GitHub webhook signature: `X-Hub-Signature-256: sha256=<hex HMAC of the raw body>`. */
export function verifyGitHubSignature(rawBody: string | Uint8Array, signature: string | null, secret: string): boolean {
  if (!signature?.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`);
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const b64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");

/** App JWT (RS256), valid 9 minutes, backdated 60 s for clock drift, as GitHub recommends. */
export function appJwt(appId: string, privateKeyPem: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId }));
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKeyPem);
  return `${header}.${payload}.${b64url(signature)}`;
}

type Cached = { token: string; expiresAt: number };
const tokens = new Map<number, Cached>();

/** Installation access token, cached until a minute before it expires. */
export async function installationToken(
  installationId: number,
  cfg: { appId: string; privateKeyPem: string },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const hit = tokens.get(installationId);
  if (hit && hit.expiresAt - 60_000 > Date.now()) return hit.token;
  const res = await fetchImpl(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${appJwt(cfg.appId, cfg.privateKeyPem)}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`installation token failed: ${res.status}`);
  const body = (await res.json()) as { token: string; expires_at: string };
  tokens.set(installationId, { token: body.token, expiresAt: Date.parse(body.expires_at) });
  return body.token;
}
