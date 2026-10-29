/**
 * Decides whether a PR is agent-declared. Only declared PRs are ever asked for a bond:
 * humans are never charged by default, and an agent that hides lands in the normal queue.
 */
export type PullRequestMeta = {
  authorType: "User" | "Bot" | "Organization";
  body: string;
  labels: string[];
  commitMessages: string[];
};

export type Declaration = { declared: boolean; reasons: string[] };

const AGENTS = [
  "claude",
  "anthropic",
  "copilot",
  "codex",
  "openai",
  "cursor",
  "devin",
  "aider",
  "openhands",
  "muse code",
  "sweep",
  "jules",
  "gemini",
  "amp",
];

const AGENT_NAME = new RegExp(`\\b(${AGENTS.map((a) => a.replace(" ", "\\s+")).join("|")})\\b`, "i");
const CO_AUTHOR = /^co-authored-by:\s*(.+)$/gim;
const GENERATED_WITH = /(generated|created|written)\s+(with|by)\s+\[?([^\]\n(]+)/i;

export function detectDeclaration(pr: PullRequestMeta): Declaration {
  const reasons: string[] = [];
  if (pr.authorType === "Bot") reasons.push("author is a GitHub Bot account");
  if (pr.labels.some((l) => l.toLowerCase() === "agent")) reasons.push("labelled `agent`");

  const generated = pr.body.match(GENERATED_WITH);
  if (generated && AGENT_NAME.test(generated[3])) reasons.push(`body says "${generated[0].trim()}"`);

  for (const msg of pr.commitMessages) {
    for (const m of msg.matchAll(CO_AUTHOR)) {
      if (AGENT_NAME.test(m[1])) {
        reasons.push(`commit trailer "Co-authored-by: ${m[1].trim()}"`);
        break;
      }
    }
  }
  return { declared: reasons.length > 0, reasons: [...new Set(reasons)] };
}
