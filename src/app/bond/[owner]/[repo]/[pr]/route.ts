import { BondRefParams, bondStatus } from "@/lib/bond-status";
import { appConfig } from "@/lib/env";
import { bondStore } from "@/lib/store";

/**
 * GET /bond/{owner}/{repo}/{pr}?sha={headSha}
 * 402 + terms while no bond is held; 200 + status afterwards. Read-only: it never moves money.
 */
export async function GET(request: Request, { params }: { params: Promise<{ owner: string; repo: string; pr: string }> }) {
  const sha = new URL(request.url).searchParams.get("sha");
  const parsed = BondRefParams.safeParse({ ...(await params), headSha: sha ?? "" });
  if (!parsed.success) {
    return Response.json(
      { error: "invalid_request", detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) },
      { status: 400 },
    );
  }
  const ref = parsed.data;
  const store = bondStore();
  const { APP_BASE_URL, BOND_AMOUNT_USD } = appConfig();
  const { httpStatus, body } = bondStatus(await store.get(ref), {
    ref,
    baseUrl: APP_BASE_URL,
    amountUsd: BOND_AMOUNT_USD,
    stats: await store.repoStats(ref.owner, ref.repo),
    now: new Date(),
  });
  return Response.json(body, { status: httpStatus, headers: { "Cache-Control": "no-store" } });
}
