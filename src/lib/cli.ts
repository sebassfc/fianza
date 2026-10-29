import type { BondStatusBody } from "@/lib/bond-status";

/** Exit codes the agent's harness can branch on. */
export const EXIT = { settled: 0, error: 1, needsHuman: 2 } as const;

export type PrRef = { owner: string; repo: string; pr: number };

/** Accepts `owner/repo#123` or a GitHub PR URL. */
export function parsePrRef(input: string): PrRef {
  const url = input.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  const short = input.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/);
  const m = url ?? short;
  if (!m) throw new Error(`expected owner/repo#123 or a GitHub PR URL, got "${input}"`);
  return { owner: m[1], repo: m[2], pr: Number(m[3]) };
}

export function bondUrl(server: string, ref: PrRef, sha: string): string {
  const base = server.replace(/\/$/, "");
  return `${base}/bond/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/${ref.pr}?sha=${encodeURIComponent(sha)}`;
}

/** What the agent prints. On 402 it relays the server's words unchanged and tells itself to stop. */
export function render(body: BondStatusBody): { text: string; exit: number } {
  switch (body.status) {
    case "bond_required":
      return {
        exit: EXIT.needsHuman,
        text: [
          body.message,
          `Approve the hold here: ${body.approval_url}`,
          `Terms: ${body.terms_url} · offer expires ${body.expires_at}`,
          "STOP: do not retry, push again or pay. Ask your human to approve, then run `fianza status`.",
        ].join("\n"),
      };
    case "bonded":
      return { exit: EXIT.settled, text: `Bond held (${body.authorization_id}). Express review within ${body.review_within_hours} h.` };
    case "voided":
      return { exit: EXIT.settled, text: "Bond released: you were charged $0.00." };
    case "forfeited":
      return { exit: EXIT.settled, text: `Bond forfeited ($${body.charged}). Appeal: ${body.appeal_url}` };
    case "refunded":
      return { exit: EXIT.settled, text: "Appeal won: the bond was refunded in full." };
  }
}
