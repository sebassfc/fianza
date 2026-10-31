import Link from "next/link";

const steps: [string, string][] = [
  ["An AI coding agent opens a PR. Fianza sees it is agent-declared and answers with a 402-style offer.", "Un agente abre un PR. Fianza ve que es de agente y responde con una oferta tipo 402."],
  ["The agent stops and asks its human, who approves a refundable hold in PayPal. Nothing is charged.", "El agente se detiene y le pregunta a su humano, que aprueba una retención reembolsable en PayPal. No se cobra nada."],
  ["CI runs. Deterministic checks (failing CI, deleted or skipped tests) and Claude's claim check build a cited report.", "Corre el CI. Revisiones deterministas y la revisión de afirmaciones de Claude arman un reporte con citas."],
  ["Default outcome: the hold is voided and the operator pays $0. A forfeit needs 2+ hard flags and a maintainer's click.", "Resultado por defecto: se anula la retención y el operador paga $0. Para cobrar se necesitan 2+ señales duras y el clic de un maintainer."],
];

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 px-4 py-12 font-sans">
      <header className="flex flex-col gap-2">
        <h1 className="text-4xl font-semibold tracking-tight">Fianza</h1>
        <p className="text-lg">Refundable PayPal bonds that AI coding agents post for a guaranteed pull-request review.</p>
        <p className="text-zinc-600 dark:text-zinc-400" lang="es">
          Fianzas reembolsables de PayPal que los agentes de código dejan para garantizar la revisión de su PR.
        </p>
      </header>

      <ol className="flex flex-col gap-3">
        {steps.map(([en, es], i) => (
          <li key={en} className="flex gap-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <span aria-hidden className="font-mono text-zinc-500">
              {i + 1}
            </span>
            <span>
              <span className="block">{en}</span>
              <span className="block text-sm text-zinc-600 dark:text-zinc-400" lang="es">
                {es}
              </span>
            </span>
          </li>
        ))}
      </ol>

      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Humans are never asked for money. Instructions hidden in a PR freeze the decision at review. All money is PayPal sandbox money. ·
        <span lang="es"> A los humanos nunca se les pide dinero. Todo el dinero es del sandbox de PayPal.</span>
      </p>

      <nav className="flex gap-4">
        <Link className="rounded-full bg-zinc-900 px-5 py-2 text-white dark:bg-zinc-100 dark:text-zinc-900" href="/dashboard">
          Maintainer dashboard · Panel
        </Link>
      </nav>
    </main>
  );
}
