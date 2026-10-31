import { z } from "zod";
import type { BondRef } from "@/lib/paypal/bond";
import type { BondRecord, RepoStats } from "@/lib/store";

/** How long the express lane promises a human review once the bond is held. */
export const EXPRESS_REVIEW_HOURS = 48;
/** How long a 402 offer stays valid before the agent should ask again. */
const OFFER_TTL_MS = 24 * 60 * 60 * 1000;

export const BondRefParams = z.object({
  owner: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
  repo: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
  pr: z.coerce.number().int().positive(),
  headSha: z.string().regex(/^[0-9a-f]{7,40}$/i, "head SHA must be hex"),
});

export type PaymentRequired = {
  status: "bond_required";
  amount: string;
  currency: "USD";
  approval_url: string;
  terms_url: string;
  expires_at: string;
  repo_forfeit_rate: string;
  express_review_hours: number;
  /** Plain words for the agent to relay to its human, unchanged. */
  message: string;
};

export type BondStatusBody =
  | PaymentRequired
  | { status: "bonded"; authorization_id: string; review_within_hours: number }
  | { status: "voided"; charged: "0.00" }
  | { status: "forfeited"; charged: string; appeal_url: string }
  | { status: "refunded"; charged: "0.00" };

export function forfeitRateLabel(stats: RepoStats, lang: "en" | "es" = "en"): string {
  if (stats.bonds === 0) return lang === "en" ? "no bonds yet" : "todavía no hay fianzas";
  const pct = Math.round((stats.forfeits / stats.bonds) * 100);
  return lang === "en" ? `${stats.forfeits} of ${stats.bonds} (${pct}%)` : `${stats.forfeits} de ${stats.bonds} (${pct}%)`;
}

/**
 * The 402-style answer for one PR. It never creates a PayPal order: the order is created only when
 * a human opens the approval page, so a flood of agent requests costs nothing and charges no one.
 */
export function bondStatus(
  record: BondRecord | null,
  ctx: { ref: BondRef; baseUrl: string; amountUsd: string; stats: RepoStats; now: Date },
): { httpStatus: 200 | 402; body: BondStatusBody } {
  const { owner, repo, pr, headSha } = ctx.ref;
  const base = ctx.baseUrl.replace(/\/$/, "");
  const prPath = `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${pr}`;

  switch (record?.state ?? "AWAITING_BOND") {
    case "AWAITING_BOND": {
      const amount = record?.amountUsd ?? ctx.amountUsd;
      const rate = forfeitRateLabel(ctx.stats);
      return {
        httpStatus: 402,
        body: {
          status: "bond_required",
          amount,
          currency: "USD",
          approval_url: `${base}/pay/${prPath}?sha=${headSha}`,
          terms_url: `${base}/terms/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
          expires_at: new Date(ctx.now.getTime() + OFFER_TTL_MS).toISOString(),
          repo_forfeit_rate: rate,
          express_review_hours: EXPRESS_REVIEW_HOURS,
          message:
            `${owner}/${repo} asks AI-agent pull requests for a refundable $${amount} USD bond to get a guaranteed review within ${EXPRESS_REVIEW_HOURS} hours. ` +
            `It is a hold, not a charge: honest work is released at $0. Past forfeits in this repo: ${rate}. ` +
            `A human must approve it in PayPal.`,
        },
      };
    }
    case "BONDED":
      return {
        httpStatus: 200,
        body: { status: "bonded", authorization_id: record!.authorizationId ?? "", review_within_hours: EXPRESS_REVIEW_HOURS },
      };
    case "VOIDED":
      return { httpStatus: 200, body: { status: "voided", charged: "0.00" } };
    case "CAPTURED":
      return { httpStatus: 200, body: { status: "forfeited", charged: record!.amountUsd, appeal_url: `${base}/appeal/${prPath}?sha=${headSha}` } };
    case "REFUNDED":
      return { httpStatus: 200, body: { status: "refunded", charged: "0.00" } };
  }
}
