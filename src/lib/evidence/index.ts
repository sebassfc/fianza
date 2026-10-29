import type { Evidence, Flag } from "@/lib/policy";
import { parseDiff } from "./diff";
import { findInjection, type InjectionHit } from "./injection";
import { ciFlags, deletedTests, testWeakening, type CiStatus } from "./rules";

export { detectDeclaration, type Declaration, type PullRequestMeta } from "./declared";
export type { CiStatus } from "./rules";

export type EvidenceInput = {
  diff: string;
  ci: CiStatus;
  /** PR title, body and comments: anything an agent wrote that a model might read. */
  texts: string[];
  /** Flags from checks that run elsewhere (the GitHub Action, the claim-checker). */
  extraFlags?: Flag[];
  /** False when an external check timed out or crashed. */
  externalChecksComplete?: boolean;
};

export type EvidenceReport = Evidence & { injection: InjectionHit[]; filesChanged: number };

/**
 * Builds the deterministic evidence the policy reads. Added diff lines are scanned for injection too:
 * an instruction hidden in a code comment is still an instruction.
 */
export function buildEvidence(input: EvidenceInput): EvidenceReport {
  const files = parseDiff(input.diff);
  const addedText = files.flatMap((f) => f.lines.filter((l) => l.kind === "add").map((l) => l.text)).join("\n");
  const injection = findInjection([...input.texts, addedText]);
  const flags: Flag[] = [...ciFlags(input.ci), ...deletedTests(files), ...testWeakening(files), ...(input.extraFlags ?? [])];
  const ciKnown = input.ci.conclusion === "success" || input.ci.conclusion === "failure";
  return {
    flags,
    injectionDetected: injection.length > 0,
    complete: ciKnown && input.externalChecksComplete !== false,
    injection,
    filesChanged: files.length,
  };
}
