import { checkClaims } from "@/lib/claims";
import { appConfig } from "@/lib/env";
import { restGitHub } from "@/lib/github/api";
import { installationToken, verifyGitHubSignature } from "@/lib/github/auth";
import { handleGitHubEvent } from "@/lib/github/handler";
import { captureBond, getAuthorization, getCapture, refundBond, voidBond } from "@/lib/paypal/bond";
import { bondStore, eventLedger } from "@/lib/store";

/** POST /webhooks/github: the Fianza GitHub App's webhook. */
export async function POST(request: Request) {
  const { GITHUB_WEBHOOK_SECRET, GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY } = process.env;
  if (!GITHUB_WEBHOOK_SECRET || !GITHUB_APP_ID || !GITHUB_APP_PRIVATE_KEY) {
    return Response.json({ error: "GitHub App is not configured" }, { status: 503 });
  }

  const raw = new Uint8Array(await request.arrayBuffer());
  if (!verifyGitHubSignature(raw, request.headers.get("x-hub-signature-256"), GITHUB_WEBHOOK_SECRET)) {
    return Response.json({ error: "invalid_signature" }, { status: 401 });
  }

  // GitHub redelivers on timeouts; a delivery is processed once.
  const delivery = request.headers.get("x-github-delivery") ?? "";
  const ledger = eventLedger();
  if (delivery && (await ledger.has(`gh:${delivery}`))) return Response.json({ result: "duplicate" });

  const payload = JSON.parse(new TextDecoder().decode(raw)) as { installation?: { id: number } };
  if (!payload.installation?.id) return Response.json({ result: "no_installation" });

  const token = await installationToken(payload.installation.id, { appId: GITHUB_APP_ID, privateKeyPem: GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n") });
  const store = bondStore();
  const { APP_BASE_URL, BOND_AMOUNT_USD } = appConfig();
  const result = await handleGitHubEvent(request.headers.get("x-github-event") ?? "", payload, {
    github: restGitHub(token),
    store,
    baseUrl: APP_BASE_URL,
    amountUsd: BOND_AMOUNT_USD,
    checkClaims: (input) => checkClaims(input),
    decisions: {
      voidBond,
      captureBond,
      refundBond,
      getAuthorization,
      getCapture,
      // Conservative: counts every forfeit in the repo, so the cap can only trip early, never late.
      forfeitsThisMonth: async (owner, repo) => (await store.repoStats(owner, repo)).forfeits,
      monthlyForfeitCap: Number(process.env.FIANZA_MONTHLY_FORFEIT_CAP ?? "5"),
      now: () => new Date(),
    },
    now: () => new Date(),
  });
  if (delivery) await ledger.add(`gh:${delivery}`);
  return Response.json({ result });
}
