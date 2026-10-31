import type { CiStatus, PullRequestMeta } from "@/lib/evidence";

/** The slice of the GitHub REST API Fianza uses. The handler depends on this, so tests use a fake. */
export interface GitHubApi {
  pullRequest(owner: string, repo: string, pr: number): Promise<PullRequestMeta & { title: string; headSha: string; author: string }>;
  diff(owner: string, repo: string, pr: number): Promise<string>;
  ciStatus(owner: string, repo: string, sha: string): Promise<CiStatus>;
  comment(owner: string, repo: string, pr: number, body: string): Promise<void>;
  setLabel(owner: string, repo: string, pr: number, label: string): Promise<void>;
  /** admin / maintain / write count as maintainers. */
  isMaintainer(owner: string, repo: string, login: string): Promise<boolean>;
}

const LABEL_PREFIX = "fianza:";

export function restGitHub(token: string, fetchImpl: typeof fetch = fetch): GitHubApi {
  const call = async (path: string, init: RequestInit & { accept?: string } = {}) => {
    const res = await fetchImpl(`https://api.github.com${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: init.accept ?? "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok && res.status !== 404) throw new Error(`GitHub ${init.method ?? "GET"} ${path}: ${res.status}`);
    return res;
  };
  const repoPath = (o: string, r: string) => `/repos/${encodeURIComponent(o)}/${encodeURIComponent(r)}`;

  return {
    async pullRequest(owner, repo, pr) {
      const p = (await (await call(`${repoPath(owner, repo)}/pulls/${pr}`)).json()) as {
        title: string;
        body: string | null;
        head: { sha: string };
        user: { login: string; type: "User" | "Bot" | "Organization" };
        labels: { name: string }[];
      };
      const commits = (await (await call(`${repoPath(owner, repo)}/pulls/${pr}/commits?per_page=100`)).json()) as { commit: { message: string } }[];
      return {
        title: p.title,
        body: p.body ?? "",
        headSha: p.head.sha,
        author: p.user.login,
        authorType: p.user.type,
        labels: p.labels.map((l) => l.name),
        commitMessages: commits.map((c) => c.commit.message),
      };
    },
    async diff(owner, repo, pr) {
      return (await call(`${repoPath(owner, repo)}/pulls/${pr}`, { accept: "application/vnd.github.diff" })).text();
    },
    async ciStatus(owner, repo, sha) {
      const body = (await (await call(`${repoPath(owner, repo)}/commits/${sha}/check-runs?per_page=100`)).json()) as {
        check_runs?: { status: string; conclusion: string | null; html_url: string; app?: { slug?: string } }[];
      };
      // Fianza's own check runs never count as CI evidence about the PR.
      const runs = (body.check_runs ?? []).filter((r) => r.app?.slug !== "fianza");
      if (runs.length === 0) return { conclusion: "missing" };
      if (runs.some((r) => r.status !== "completed")) return { conclusion: "pending" };
      const failed = runs.find((r) => r.conclusion === "failure" || r.conclusion === "timed_out");
      return failed ? { conclusion: "failure", url: failed.html_url } : { conclusion: "success" };
    },
    async comment(owner, repo, pr, body) {
      await call(`${repoPath(owner, repo)}/issues/${pr}/comments`, { method: "POST", body: JSON.stringify({ body }) });
    },
    async setLabel(owner, repo, pr, label) {
      // One fianza:* label at a time: remove the others, then add this one.
      const current = (await (await call(`${repoPath(owner, repo)}/issues/${pr}/labels`)).json()) as { name: string }[];
      for (const l of current) {
        if (l.name.startsWith(LABEL_PREFIX) && l.name !== label) {
          await call(`${repoPath(owner, repo)}/issues/${pr}/labels/${encodeURIComponent(l.name)}`, { method: "DELETE" });
        }
      }
      await call(`${repoPath(owner, repo)}/issues/${pr}/labels`, { method: "POST", body: JSON.stringify({ labels: [label] }) });
    },
    async isMaintainer(owner, repo, login) {
      const res = await call(`${repoPath(owner, repo)}/collaborators/${encodeURIComponent(login)}/permission`);
      if (res.status === 404) return false;
      const { permission } = (await res.json()) as { permission: string };
      return ["admin", "maintain", "write"].includes(permission);
    },
  };
}
