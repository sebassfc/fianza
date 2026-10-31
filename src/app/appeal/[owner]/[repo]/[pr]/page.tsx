import { Suspense } from "react";

export default function Appeal(props: PageProps<"/appeal/[owner]/[repo]/[pr]">) {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 px-4 py-10 font-sans">
      <Suspense fallback={<p>Loading… · Cargando…</p>}>
        <AppealBody {...props} />
      </Suspense>
    </main>
  );
}

async function AppealBody({ params }: PageProps<"/appeal/[owner]/[repo]/[pr]">) {
  const { owner, repo, pr } = await params;
  const prUrl = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pull/${encodeURIComponent(pr)}`;
  return (
    <>
      <h1 className="text-3xl font-semibold tracking-tight">Appeal a forfeit · Apelar un cobro</h1>
      <p>
        Reply on the pull request explaining why the evidence is wrong (for example, a test was skipped on purpose and the reason is in the commit). A maintainer
        who agrees runs <code className="font-mono">/fianza appeal</code> and the bond is refunded in full.
      </p>
      <p className="text-zinc-700 dark:text-zinc-300" lang="es">
        Responde en el PR explicando por qué la evidencia está mal. Si un maintainer está de acuerdo, ejecuta <code className="font-mono">/fianza apelar</code> y se
        reembolsa la fianza completa.
      </p>
      <a className="w-fit rounded-full bg-zinc-900 px-5 py-2 text-white dark:bg-zinc-100 dark:text-zinc-900" href={prUrl}>
        Open the pull request · Abrir el PR
      </a>
    </>
  );
}
