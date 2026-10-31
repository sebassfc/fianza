import type { Declaration, EvidenceReport } from "@/lib/evidence";
import type { BondRef } from "@/lib/paypal/bond";
import { MIN_HARD_FLAGS_TO_FORFEIT, hardDeterministicFlags, type Recommendation } from "@/lib/policy";

type Lang = "en" | "es";

const FLAG_LABELS: Record<string, Record<Lang, string>> = {
  ci_failed: { en: "CI is failing", es: "El CI está fallando" },
  test_file_deleted: { en: "A test file was deleted", es: "Se borró un archivo de pruebas" },
  assertions_removed: { en: "Assertions were removed from tests", es: "Se quitaron aserciones de las pruebas" },
  tests_skipped_or_focused: { en: "Tests were skipped or focused (.skip / .only)", es: "Se saltaron o aislaron pruebas (.skip / .only)" },
  trivial_assertion: { en: "A trivially-true assertion was added", es: "Se agregó una aserción que siempre pasa" },
  error_swallowed: { en: "An error is swallowed (empty catch)", es: "Se traga un error (catch vacío)" },
};

const RECOMMENDATION: Record<Recommendation, Record<Lang, string>> = {
  VOID: { en: "Release the bond: the operator pays $0", es: "Liberar la fianza: el operador paga $0" },
  REVIEW: { en: "A maintainer should review; no money moves on its own", es: "Que lo revise un maintainer; el dinero no se mueve solo" },
  FORFEIT_PROPOSED: {
    en: "Forfeit proposed: nothing is charged unless a maintainer confirms",
    es: "Se propone cobrar: no se cobra nada hasta que un maintainer lo confirme",
  },
};

const T = {
  title: { en: "Fianza evidence report", es: "Reporte de evidencia de Fianza" },
  recommendation: { en: "Recommendation", es: "Recomendación" },
  declared: { en: "Agent-declared because", es: "Declarado por agente porque" },
  noFlags: { en: "No deterministic red flags.", es: "Sin señales deterministas." },
  hardCount: {
    en: (n: number) => `Hard deterministic flags: ${n} (${MIN_HARD_FLAGS_TO_FORFEIT} needed to propose a forfeit). Model findings never move money.`,
    es: (n: number) => `Señales duras deterministas: ${n} (se necesitan ${MIN_HARD_FLAGS_TO_FORFEIT} para proponer cobrar). Lo que diga un modelo nunca mueve dinero.`,
  },
  injection: {
    en: "Instructions aimed at the reviewer or a model were found, so this recommendation is frozen at REVIEW:",
    es: "Se encontraron instrucciones dirigidas al revisor o a un modelo, así que la recomendación queda congelada en revisión:",
  },
  incomplete: {
    en: "Some evidence is still missing (CI pending or a check failed to run). Incomplete evidence can never forfeit a bond.",
    es: "Falta evidencia (CI pendiente o un chequeo no corrió). Con evidencia incompleta nunca se cobra una fianza.",
  },
  commands: {
    en: "Maintainer commands: `/fianza accept` (release, $0) · `/fianza forfeit` (only when proposed) · `/fianza appeal` (refund a forfeit)",
    es: "Comandos del maintainer: `/fianza aceptar` (liberar, $0) · `/fianza cobrar` (solo si se propuso) · `/fianza apelar` (reembolsar un cobro)",
  },
  thanks: {
    en: "Thanks for the contribution. This report judges the diff, never how the description is written.",
    es: "Gracias por la contribución. Este reporte juzga el diff, nunca cómo está escrita la descripción.",
  },
} as const;

function section(lang: Lang, r: { ref: BondRef; declaration: Declaration; evidence: EvidenceReport; recommendation: Recommendation }): string {
  const lines: string[] = [];
  lines.push(`**${T.recommendation[lang]}: ${RECOMMENDATION[r.recommendation][lang]}**`, "");
  if (r.declaration.declared) lines.push(`${T.declared[lang]}: ${r.declaration.reasons.join("; ")}.`, "");

  if (r.evidence.flags.length === 0) {
    lines.push(T.noFlags[lang]);
  } else {
    lines.push(lang === "en" ? "| Finding | Severity | Where |" : "| Hallazgo | Severidad | Dónde |", "|---|---|---|");
    for (const f of r.evidence.flags) {
      const label = FLAG_LABELS[f.id]?.[lang] ?? f.id;
      const sev = f.severity === "hard" ? (lang === "en" ? "hard" : "dura") : lang === "en" ? "soft" : "suave";
      lines.push(`| ${label} | ${sev}${f.source === "llm" ? " (model)" : ""} | \`${f.ref ?? "-"}\` |`);
    }
  }
  lines.push("", T.hardCount[lang](hardDeterministicFlags(r.evidence).length));

  if (r.evidence.injectionDetected) {
    lines.push("", `> ⚠️ ${T.injection[lang]}`);
    for (const hit of r.evidence.injection) lines.push(`> - \`${hit.excerpt.replace(/`/g, "'")}\``);
  }
  if (!r.evidence.complete) lines.push("", `> ⏳ ${T.incomplete[lang]}`);
  lines.push("", T.commands[lang], "", `_${T.thanks[lang]}_`);
  return lines.join("\n");
}

/** The PR comment: English first, Spanish in a collapsible block. Deterministic text, no model involved. */
export function renderReport(r: { ref: BondRef; declaration: Declaration; evidence: EvidenceReport; recommendation: Recommendation }): string {
  const head = `### ${T.title.en} · \`${r.ref.owner}/${r.ref.repo}#${r.ref.pr}\` @ \`${r.ref.headSha.slice(0, 7)}\``;
  return [head, "", section("en", r), "", "<details><summary>Español</summary>", "", section("es", r), "", "</details>"].join("\n");
}
