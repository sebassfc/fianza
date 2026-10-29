/** A unified diff, split per file, keeping line numbers so every flag can cite `path:line`. */
export type DiffLine = { kind: "add" | "del"; text: string; line: number };
export type FileDiff = { path: string; oldPath: string; status: "added" | "deleted" | "modified" | "renamed"; lines: DiffLine[] };

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Parses `git diff` / GitHub `.diff` output. Binary files keep their entry with no lines. */
export function parseDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      const m = raw.match(/^diff --git a\/(.+) b\/(.+)$/);
      current = { path: m?.[2] ?? "", oldPath: m?.[1] ?? "", status: "modified", lines: [] };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (raw.startsWith("new file mode")) current.status = "added";
    else if (raw.startsWith("deleted file mode")) current.status = "deleted";
    else if (raw.startsWith("rename from ")) current.status = "renamed";
    else if (raw.startsWith("--- ") || raw.startsWith("+++ ")) continue;
    else if (raw.startsWith("@@")) {
      const h = raw.match(HUNK);
      if (h) {
        oldLine = Number(h[1]);
        newLine = Number(h[2]);
      }
    } else if (raw.startsWith("+")) current.lines.push({ kind: "add", text: raw.slice(1), line: newLine++ });
    else if (raw.startsWith("-")) current.lines.push({ kind: "del", text: raw.slice(1), line: oldLine++ });
    else if (raw.startsWith(" ")) {
      oldLine++;
      newLine++;
    }
  }
  return files;
}

const TEST_FILE = /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/;

export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path);
}
