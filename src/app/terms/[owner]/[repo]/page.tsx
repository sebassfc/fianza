import { Suspense } from "react";
import { EXPRESS_REVIEW_HOURS, forfeitRateLabel } from "@/lib/bond-status";
import { appConfig } from "@/lib/env";
import { MIN_HARD_FLAGS_TO_FORFEIT } from "@/lib/policy";
import { bondStore } from "@/lib/store";

export default function Terms(props: PageProps<"/terms/[owner]/[repo]">) {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-5 px-4 py-10 font-sans">
      <Suspense fallback={<p>Loading… · Cargando…</p>}>
        <TermsBody {...props} />
      </Suspense>
    </main>
  );
}

async function TermsBody({ params }: PageProps<"/terms/[owner]/[repo]">) {
  const { owner, repo } = await params;
  const stats = await bondStore().repoStats(owner, repo);
  const { BOND_AMOUNT_USD } = appConfig();
  const items: [string, string][] = [
    [`Who: only pull requests declared as agent-generated. Humans are never asked for a bond.`, "Quién: solo PRs declarados como de agente. A los humanos nunca se les pide fianza."],
    [`What: a refundable PayPal hold of $${BOND_AMOUNT_USD} USD on the exact commit. It buys a review within ${EXPRESS_REVIEW_HOURS} hours.`, `Qué: una retención reembolsable de PayPal de $${BOND_AMOUNT_USD} USD sobre el commit exacto. Compra una revisión en ${EXPRESS_REVIEW_HOURS} horas.`],
    ["Default: the hold is voided. Honest work costs $0.", "Por defecto: la retención se anula. El trabajo honesto cuesta $0."],
    [
      `Forfeit: only when at least ${MIN_HARD_FLAGS_TO_FORFEIT} deterministic red flags exist (failing CI, deleted or skipped tests, trivially-true assertions) and a maintainer confirms. A model's opinion never counts. Prompt injection freezes the decision at review.`,
      `Cobro: solo con al menos ${MIN_HARD_FLAGS_TO_FORFEIT} señales deterministas (CI fallando, pruebas borradas o saltadas, aserciones que siempre pasan) y la confirmación de un maintainer. La opinión de un modelo nunca cuenta.`,
    ],
    ["Cap: a repo can forfeit only a limited number of bonds per month.", "Tope: un repo solo puede cobrar un número limitado de fianzas al mes."],
    ["Appeal: ask on the PR; a maintainer's `/fianza appeal` refunds the bond in full.", "Apelación: pídela en el PR; con `/fianza apelar` un maintainer reembolsa todo."],
    [`Track record in ${owner}/${repo}: ${forfeitRateLabel(stats)} forfeited.`, `Historial en ${owner}/${repo}: ${forfeitRateLabel(stats, "es")} cobradas.`],
  ];
  return (
    <>
      <h1 className="text-3xl font-semibold tracking-tight">
        Bond terms · {owner}/{repo}
      </h1>
      <p className="text-zinc-600 dark:text-zinc-400" lang="es">
        Términos de la fianza
      </p>
      <ul className="flex flex-col gap-3">
        {items.map(([en, es]) => (
          <li key={en} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <span className="block">{en}</span>
            <span className="block text-sm text-zinc-600 dark:text-zinc-400" lang="es">
              {es}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}
