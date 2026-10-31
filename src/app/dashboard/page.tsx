import { connection } from "next/server";
import { Suspense } from "react";
import { bondStore, type BondRecord } from "@/lib/store";

const STATE_LABEL: Record<BondRecord["state"], string> = {
  AWAITING_BOND: "Awaiting bond · En espera",
  BONDED: "Held · Retenida",
  VOIDED: "Released ($0) · Liberada",
  CAPTURED: "Forfeited · Cobrada",
  REFUNDED: "Refunded · Reembolsada",
};

export default function Dashboard() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-4 py-10 font-sans">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Maintainer dashboard</h1>
        <p className="text-zinc-600 dark:text-zinc-400" lang="es">
          Panel del maintainer: cada fianza, su estado y su historial.
        </p>
      </header>
      <Suspense fallback={<p>Loading… · Cargando…</p>}>
        <Ledger />
      </Suspense>
    </main>
  );
}

async function Ledger() {
  // Request-time data: without this the in-memory store would be read once at build time.
  await connection();
  const bonds = await bondStore().list({ limit: 100 });
  if (bonds.length === 0) return <p>No bonds yet. · Todavía no hay fianzas.</p>;
  const count = (s: BondRecord["state"]) => bonds.filter((b) => b.state === s).length;

  return (
    <>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {(Object.keys(STATE_LABEL) as BondRecord["state"][]).map((s) => (
          <div key={s} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <dt className="text-xs text-zinc-600 dark:text-zinc-400">{STATE_LABEL[s]}</dt>
            <dd className="text-2xl font-semibold">{count(s)}</dd>
          </div>
        ))}
      </dl>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Bonds, most recent first</caption>
          <thead>
            <tr className="border-b border-zinc-200 dark:border-zinc-800">
              <th scope="col" className="py-2 pr-3">PR</th>
              <th scope="col" className="py-2 pr-3">State · Estado</th>
              <th scope="col" className="py-2 pr-3">Recommendation</th>
              <th scope="col" className="py-2 pr-3">Amount</th>
              <th scope="col" className="py-2">Last event · Último evento</th>
            </tr>
          </thead>
          <tbody>
            {bonds.map((b) => {
              const last = b.history.at(-1);
              return (
                <tr key={`${b.ref.owner}/${b.ref.repo}#${b.ref.pr}@${b.ref.headSha}`} className="border-b border-zinc-100 align-top dark:border-zinc-900">
                  <td className="py-2 pr-3 font-mono">
                    {b.ref.owner}/{b.ref.repo}#{b.ref.pr}
                    <span className="block text-xs text-zinc-500">@{b.ref.headSha.slice(0, 7)}</span>
                  </td>
                  <td className="py-2 pr-3">{STATE_LABEL[b.state]}</td>
                  <td className="py-2 pr-3">{b.recommendation ?? "—"}</td>
                  <td className="py-2 pr-3">${b.amountUsd}</td>
                  <td className="py-2">
                    {last ? (
                      <>
                        {last.event}
                        <span className="block text-xs text-zinc-500">{last.at}</span>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
