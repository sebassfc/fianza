import { z } from "zod";
import { payPageUrl } from "@/lib/bond-flow";
import type { ClaimCheck } from "@/lib/claims";
import { decide, parseCommand, type DecisionDeps, type MaintainerAction } from "@/lib/decisions";
import { buildEvidence, detectDeclaration } from "@/lib/evidence";
import { recommend, type Recommendation } from "@/lib/policy";
import { renderReport } from "@/lib/report";
import type { BondStore } from "@/lib/store";
import type { GitHubApi } from "./api";

export type HandlerDeps = {
  github: GitHubApi;
  store: BondStore;
  baseUrl: string;
  amountUsd: string;
  checkClaims: (input: { title: string; body: string; diff: string }) => Promise<ClaimCheck>;
  decisions: Omit<DecisionDeps, "store">;
  now: () => Date;
};

const Repo = z.object({ name: z.string(), owner: z.object({ login: z.string() }) });

const PullRequestEvent = z.object({
  action: z.string(),
  number: z.number(),
  repository: Repo,
});

const CheckSuiteEvent = z.object({
  action: z.string(),
  check_suite: z.object({ head_sha: z.string(), pull_requests: z.array(z.object({ number: z.number() })) }),
  repository: Repo,
});

const IssueCommentEvent = z.object({
  action: z.string(),
  issue: z.object({ number: z.number(), pull_request: z.unknown().optional() }),
  comment: z.object({ body: z.string(), user: z.object({ login: z.string(), type: z.string() }) }),
  repository: Repo,
});

const RECOMMENDATION_LABEL: Record<Recommendation, string> = {
  VOID: "fianza:recommend-release",
  REVIEW: "fianza:needs-review",
  FORFEIT_PROPOSED: "fianza:forfeit-proposed",
};

const DONE_LABEL: Record<MaintainerAction, string> = {
  accept: "fianza:released",
  forfeit: "fianza:forfeited",
  appeal: "fianza:refunded",
};

export function bondRequestComment(o: { reasons: string[]; amountUsd: string; payUrl: string; target: string; sha: string }): string {
  return [
    `This PR looks agent-generated (${o.reasons.join("; ")}). This repo offers an **express review lane**: post a refundable **$${o.amountUsd} USD** bond and a maintainer reviews it within 48 hours. Honest work is released at $0; only a maintainer can forfeit, and only on deterministic evidence.`,
    "",
    `- A human approves the hold here: ${o.payUrl}`,
    `- Or the agent runs: \`fianza request-bond ${o.target} --sha ${o.sha}\``,
    "",
    "No bond is fine too: the PR stays in the normal review queue.",
    "",
    "<details><summary>Español</summary>",
    "",
    `Este PR parece generado por un agente. Este repo ofrece un **carril exprés**: deja una fianza reembolsable de **$${o.amountUsd} USD** y un maintainer lo revisa en menos de 48 horas. El trabajo honesto se libera en $0; solo un maintainer puede cobrar, y solo con evidencia determinista. Aprueba la retención aquí: ${o.payUrl}. Sin fianza también está bien: el PR sigue en la fila normal.`,
    "",
    "</details>",
  ].join("\n");
}

function claimsSection(check: ClaimCheck): string {
  if (!check.complete) {
    return `\n**Claim check (AI):** incomplete (${check.reason}). Incomplete evidence can never forfeit a bond. · **Revisión de afirmaciones (IA):** incompleta.`;
  }
  const rows = check.report.claims.map((c) => `| ${c.claim.replace(/\|/g, "/")} | ${c.status} | ${c.diff_refs.map((r) => `\`${r}\``).join(" ") || "-"} |`);
  return [
    "",
    "**Claim check (AI, informational: it never moves money)** · **Revisión de afirmaciones (IA, informativa)**",
    "",
    rows.length ? ["| Claim | Status | Where |", "|---|---|---|", ...rows].join("\n") : "_The description makes no concrete claims._",
    "",
    `> ${check.report.summary_en}`,
    `> ${check.report.summary_es}`,
  ].join("\n");
}

function decisionComment(action: MaintainerAction, result: Awaited<ReturnType<typeof decide>>, login: string): string {
  if (result.ok) {
    const what: Record<MaintainerAction, string> = {
      accept: "Bond released: the operator was charged $0. · Fianza liberada: se cobraron $0.",
      forfeit: "Bond forfeited after a maintainer confirmed the proposed forfeit. · Fianza cobrada tras la confirmación de un maintainer.",
      appeal: "Appeal granted: the bond was refunded in full. · Apelación aceptada: la fianza se reembolsó completa.",
    };
    return `${what[action]}${result.already ? " (already done)" : ""}${result.recovered ? " (confirmed with PayPal after a timeout)" : ""} — @${login}`;
  }
  const why: Record<string, string> = {
    not_maintainer: "Only maintainers can do that. · Solo un maintainer puede hacerlo.",
    wrong_state: "That does not apply to this bond's current state. · No aplica al estado actual de la fianza.",
    not_proposed: "No forfeit was proposed: deterministic evidence did not reach the threshold. · No se propuso cobrar.",
    monthly_cap_reached: "This repo reached its monthly forfeit cap. · El repo llegó a su tope mensual de cobros.",
    not_bonded: "No bond is held for this PR. · No hay fianza retenida para este PR.",
    missing_payment_id: "The payment reference is missing; nothing changed. · Falta la referencia de pago; no cambió nada.",
  };
  return why[result.reason] ?? result.reason;
}

export async function handleGitHubEvent(name: string, payload: unknown, deps: HandlerDeps): Promise<string> {
  if (name === "pull_request") {
    const e = PullRequestEvent.parse(payload);
    if (!["opened", "reopened", "synchronize"].includes(e.action)) return "ignored_action";
    const owner = e.repository.owner.login;
    const repo = e.repository.name;
    const meta = await deps.github.pullRequest(owner, repo, e.number);
    const declaration = detectDeclaration(meta);
    if (!declaration.declared) return "human_pr_free_lane";

    const ref = { owner, repo, pr: e.number, headSha: meta.headSha };
    if (await deps.store.get(ref)) return "already_requested";
    await deps.store.put({
      ref,
      state: "AWAITING_BOND",
      amountUsd: deps.amountUsd,
      history: [{ at: deps.now().toISOString(), event: "bond_requested", note: declaration.reasons.join("; ") }],
    });
    await deps.github.setLabel(owner, repo, e.number, "fianza:awaiting-bond");
    await deps.github.comment(
      owner,
      repo,
      e.number,
      bondRequestComment({ reasons: declaration.reasons, amountUsd: deps.amountUsd, payUrl: payPageUrl(deps.baseUrl, ref), target: `${owner}/${repo}#${e.number}`, sha: meta.headSha }),
    );
    return "bond_requested";
  }

  if (name === "check_suite") {
    const e = CheckSuiteEvent.parse(payload);
    if (e.action !== "completed") return "ignored_action";
    const owner = e.repository.owner.login;
    const repo = e.repository.name;
    let reported = 0;
    for (const { number } of e.check_suite.pull_requests) {
      const meta = await deps.github.pullRequest(owner, repo, number);
      if (meta.headSha !== e.check_suite.head_sha) continue; // stale suite for an older commit
      const ref = { owner, repo, pr: number, headSha: meta.headSha };
      const record = await deps.store.get(ref);
      if (!record) continue; // human PRs are never evaluated for money

      const diff = await deps.github.diff(owner, repo, number);
      const ci = await deps.github.ciStatus(owner, repo, meta.headSha);
      const claims = await deps.checkClaims({ title: meta.title, body: meta.body, diff });
      const evidence = buildEvidence({
        diff,
        ci,
        texts: [meta.title, meta.body],
        extraFlags: claims.complete ? claims.flags : [],
        externalChecksComplete: claims.complete,
      });
      const recommendation = recommend(evidence);
      await deps.store.put({
        ...record,
        recommendation,
        history: [...record.history, { at: deps.now().toISOString(), event: "evidence", note: `${recommendation}; ${evidence.flags.length} flags` }],
      });
      await deps.github.comment(owner, repo, number, renderReport({ ref, declaration: detectDeclaration(meta), evidence, recommendation }) + claimsSection(claims));
      await deps.github.setLabel(owner, repo, number, RECOMMENDATION_LABEL[recommendation]);
      reported++;
    }
    return reported ? `reported:${reported}` : "nothing_to_report";
  }

  if (name === "issue_comment") {
    const e = IssueCommentEvent.parse(payload);
    if (e.action !== "created" || e.issue.pull_request === undefined) return "ignored_action";
    if (e.comment.user.type === "Bot") return "ignored_bot";
    const action = parseCommand(e.comment.body);
    if (!action) return "no_command";

    const owner = e.repository.owner.login;
    const repo = e.repository.name;
    const login = e.comment.user.login;
    const meta = await deps.github.pullRequest(owner, repo, e.issue.number);
    const record = await deps.store.get({ owner, repo, pr: e.issue.number, headSha: meta.headSha });
    if (!record) {
      await deps.github.comment(owner, repo, e.issue.number, "There is no Fianza bond for this PR's current commit. · No hay fianza de Fianza para el commit actual de este PR.");
      return "no_bond";
    }
    const isMaintainer = await deps.github.isMaintainer(owner, repo, login);
    try {
      const result = await decide(record, action, { login, isMaintainer }, { ...deps.decisions, store: deps.store });
      await deps.github.comment(owner, repo, e.issue.number, decisionComment(action, result, login));
      if (result.ok) await deps.github.setLabel(owner, repo, e.issue.number, DONE_LABEL[action]);
      return result.ok ? `decided:${action}` : `refused:${result.reason}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await deps.github.comment(owner, repo, e.issue.number, `PayPal could not complete \`/fianza ${action}\`; nothing changed. Try again in a minute. · PayPal no pudo completarlo; no cambió nada.\n\n\`${msg}\``);
      return "paypal_error";
    }
  }

  return "ignored_event";
}
