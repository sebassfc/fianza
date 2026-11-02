import type { Flag } from "@/lib/policy";
import { isTestFile, type FileDiff } from "./diff";

const ASSERTION = /\b(expect|assert(?:Equal|True|False|That|Throws)?|should)\s*\(|\bassert\.\w+\s*\(|^\s*assert\s|\.should\./;
const FOCUS_OR_SKIP = /\b(it|test|describe)\.(skip|only|todo)\s*\(|\b(xit|xdescribe|xtest|fit|fdescribe)\s*\(|@pytest\.mark\.skip|t\.Skip\(/;
const TRIVIAL_ASSERTION = /\bexpect\s*\(\s*(true|1|!0)\s*\)\s*\.to(Be|Equal)\s*\(\s*(true|1|!0)\s*\)|\bassert\s*\(?\s*True\s*\)?\s*$|\bassert\.ok\s*\(\s*true\s*\)/;
const EMPTY_CATCH = /\bcatch\s*(\([^)]*\))?\s*\{\s*\}|\bexcept[^:]*:\s*pass\b/;

const flag = (id: string, severity: Flag["severity"], ref: string): Flag => ({ id, source: "deterministic", severity, ref });

/**
 * Test-weakening rules over the diff. Each returns at most one flag per file, citing the first line.
 * - net loss of assertions in a test file: hard
 * - added .skip / .only / xit / pytest skip: hard
 * - added trivially-true assertion: hard
 * - added empty catch / except-pass anywhere: soft (sometimes legitimate)
 */
export function testWeakening(files: FileDiff[]): Flag[] {
  const flags: Flag[] = [];
  for (const f of files) {
    const added = f.lines.filter((l) => l.kind === "add");
    const removed = f.lines.filter((l) => l.kind === "del");

    if (isTestFile(f.path) || isTestFile(f.oldPath)) {
      const removedAsserts = removed.filter((l) => ASSERTION.test(l.text));
      // Swapping a real assertion for `expect(true)` is a removal, not a replacement.
      const addedAsserts = added.filter((l) => ASSERTION.test(l.text) && !TRIVIAL_ASSERTION.test(l.text));
      if (removedAsserts.length > addedAsserts.length) {
        flags.push(flag("assertions_removed", "hard", `${f.oldPath}:${removedAsserts[0].line}`));
      }
      const focus = added.find((l) => FOCUS_OR_SKIP.test(l.text));
      if (focus) flags.push(flag("tests_skipped_or_focused", "hard", `${f.path}:${focus.line}`));
      const trivial = added.find((l) => TRIVIAL_ASSERTION.test(l.text));
      if (trivial) flags.push(flag("trivial_assertion", "hard", `${f.path}:${trivial.line}`));
    }

    const swallow = added.find((l) => EMPTY_CATCH.test(l.text));
    if (swallow) flags.push(flag("error_swallowed", "soft", `${f.path}:${swallow.line}`));
  }
  return flags;
}

/** A deleted test file is a hard flag on its own; the assertion count above would miss it. */
export function deletedTests(files: FileDiff[]): Flag[] {
  return files
    .filter((f) => f.status === "deleted" && isTestFile(f.oldPath))
    .map((f) => flag("test_file_deleted", "hard", f.oldPath));
}

export type CiStatus = { conclusion: "success" | "failure" | "pending" | "missing"; url?: string };

/** Failing CI is hard evidence. Pending or missing CI makes the evidence incomplete instead. */
export function ciFlags(ci: CiStatus): Flag[] {
  return ci.conclusion === "failure" ? [flag("ci_failed", "hard", ci.url ?? "checks")] : [];
}
