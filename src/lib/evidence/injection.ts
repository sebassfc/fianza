/**
 * Prompt-injection markers in the PR title, body, comments or added lines (English and Spanish).
 * A hit never forfeits anything: it freezes the recommendation at REVIEW and shows the maintainer why.
 */
const PATTERNS: { id: string; re: RegExp }[] = [
  { id: "ignore_instructions_en", re: /\b(ignore|disregard|forget)\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier)?\s*(instructions|rules|prompts?)\b/i },
  { id: "ignore_instructions_es", re: /\b(ignora|olvida|omite)\s+(todas\s+)?(las\s+)?(instrucciones|reglas)(\s+(anteriores|previas))?\b/i },
  { id: "fake_role_header", re: /^\s*(system|assistant|developer)\s*:/im },
  { id: "role_reassignment_en", re: /\byou\s+are\s+now\b|\bact\s+as\s+(the\s+)?(maintainer|admin|reviewer)\b/i },
  { id: "role_reassignment_es", re: /\bahora\s+eres\b|\bact[uú]a\s+como\s+(el\s+)?(mantenedor|admin|revisor)\b/i },
  { id: "bond_command_en", re: /\b(void|release|cancel|refund)\s+(this|the|my)\s+bond\b|\bapprove\s+(this|the)\s+(pr|pull request)\b/i },
  { id: "bond_command_es", re: /\b(anula|libera|cancela|reembolsa)\s+(esta|la|mi)\s+fianza\b|\baprueba\s+(este|el)\s+(pr|pull request)\b/i },
  { id: "model_directive", re: /\b(to|for)\s+(the\s+)?(ai|llm|model|bot|reviewer)\s*:/i },
];

/** Invisible characters that can hide instructions from a human reviewer. */
const HIDDEN = /[​-‏‪-‮⁠-⁤﻿]/;

export type InjectionHit = { id: string; excerpt: string };

export function findInjection(texts: string[]): InjectionHit[] {
  const hits: InjectionHit[] = [];
  for (const text of texts) {
    if (HIDDEN.test(text)) hits.push({ id: "hidden_characters", excerpt: "(invisible Unicode characters)" });
    // HTML comments render as nothing on GitHub, so their content is checked on its own.
    const comments = [...text.matchAll(/<!--([\s\S]*?)-->/g)].map((m) => m[1]);
    for (const chunk of [text, ...comments]) {
      for (const p of PATTERNS) {
        const m = chunk.match(p.re);
        if (m) hits.push({ id: p.id, excerpt: m[0].trim().slice(0, 80) });
      }
    }
  }
  const seen = new Set<string>();
  return hits.filter((h) => (seen.has(h.id) ? false : (seen.add(h.id), true)));
}
