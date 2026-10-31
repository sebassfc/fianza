import { Suspense } from "react";
import { BondRefParams, EXPRESS_REVIEW_HOURS, forfeitRateLabel } from "@/lib/bond-status";
import { appConfig } from "@/lib/env";
import { MIN_HARD_FLAGS_TO_FORFEIT } from "@/lib/policy";
import { bondStore } from "@/lib/store";
import { BondButton } from "./bond-button";

export default function PayPage(props: PageProps<"/pay/[owner]/[repo]/[pr]">) {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-4 py-10 font-sans">
      <Suspense fallback={<p>Loading… · Cargando…</p>}>
        <BondTerms {...props} />
      </Suspense>
    </main>
  );
}

async function BondTerms({ params, searchParams }: PageProps<"/pay/[owner]/[repo]/[pr]">) {
  const sha = (await searchParams).sha;
  const parsed = BondRefParams.safeParse({ ...(await params), headSha: typeof sha === "string" ? sha : "" });
  if (!parsed.success) return <p role="alert">This bond link is not valid. · Este enlace de fianza no es válido.</p>;

  const ref = parsed.data;
  const store = bondStore();
  const record = await store.get(ref);
  const stats = await store.repoStats(ref.owner, ref.repo);
  const { BOND_AMOUNT_USD } = appConfig();
  const amount = record?.amountUsd ?? BOND_AMOUNT_USD;
  const clientId = process.env.PAYPAL_CLIENT_ID;

  const terms: [string, string][] = [
    ["It is a hold, not a charge. Honest work is released at $0.", "Es una retención, no un cobro. El trabajo honesto se libera en $0."],
    [
      `A maintainer decides within ${EXPRESS_REVIEW_HOURS} hours. If nobody does, the hold is voided automatically.`,
      `Un maintainer decide en menos de ${EXPRESS_REVIEW_HOURS} horas. Si nadie lo hace, la retención se anula sola.`,
    ],
    [
      `A forfeit needs at least ${MIN_HARD_FLAGS_TO_FORFEIT} deterministic red flags (failing CI, deleted or skipped tests…) and a maintainer's confirmation. A model's opinion never moves money.`,
      `Para cobrar se necesitan al menos ${MIN_HARD_FLAGS_TO_FORFEIT} señales deterministas (CI fallando, pruebas borradas o saltadas…) y la confirmación de un maintainer. La opinión de un modelo nunca mueve dinero.`,
    ],
    ["A won appeal refunds the bond in full.", "Si ganas una apelación, se reembolsa completa."],
    [`Past forfeits in this repo: ${forfeitRateLabel(stats)}.`, `Cobros anteriores en este repo: ${forfeitRateLabel(stats, "es")}.`],
  ];

  return (
    <>
      <header className="flex flex-col gap-1">
        <p className="font-mono text-sm text-zinc-600 dark:text-zinc-400">
          {ref.owner}/{ref.repo}#{ref.pr} @ {ref.headSha.slice(0, 7)}
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Refundable review bond · ${amount} USD</h1>
        <p className="text-lg text-zinc-700 dark:text-zinc-300">Fianza de revisión reembolsable</p>
      </header>

      <ul className="flex flex-col gap-3">
        {terms.map(([en, es]) => (
          <li key={en} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <span className="block">{en}</span>
            <span className="block text-sm text-zinc-600 dark:text-zinc-400" lang="es">
              {es}
            </span>
          </li>
        ))}
      </ul>

      {record?.state === "BONDED" ? (
        <p role="status" className="rounded-lg bg-emerald-50 p-4 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100">
          Bond held: express review is on. Nothing was charged. · Fianza retenida: revisión exprés activada. No se cobró nada.
        </p>
      ) : record && record.state !== "AWAITING_BOND" ? (
        <p role="status" className="rounded-lg bg-zinc-100 p-4 dark:bg-zinc-900">
          This bond is already {record.state.toLowerCase()}. · Esta fianza ya está en estado {record.state.toLowerCase()}.
        </p>
      ) : clientId ? (
        <BondButton clientId={clientId} bondRef={ref} />
      ) : (
        <p role="alert" className="rounded-lg bg-amber-50 p-4 text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          PayPal is not configured on this server (PAYPAL_CLIENT_ID). · PayPal no está configurado en este servidor.
        </p>
      )}
    </>
  );
}
