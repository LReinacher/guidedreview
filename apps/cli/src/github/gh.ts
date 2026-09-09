/**
 * The `gh` CLI as a source of GitHub credentials and pull request identity.
 *
 * Everything here is best-effort: `gh` is optional, may not be logged in, and
 * may be offline. Callers get `null` rather than an exception so a missing
 * `gh` only costs the user the GitHub submit button, never the review.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Cap every `gh` call so a slow or offline network cannot stall startup. The
 * base-ref lookup runs before the CLI prints anything, so this stays short.
 */
const GH_TIMEOUT_MS = 3000;

/** `gh` must never open a browser or prompt: the CLI owns the terminal. */
const NON_INTERACTIVE_ENV = {
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
  GIT_TERMINAL_PROMPT: "0",
};

export interface GitHubPullRequest {
  owner: string;
  repo: string;
  number: number;
  url: string;
  title: string;
  author: string;
  baseRefName: string;
  headRefName: string;
  /** Head commit GitHub has. Inline comments only line up when this is local HEAD. */
  headRefOid: string;
  isDraft: boolean;
}

export type TokenSource = "gh" | "env";

export interface GitHubToken {
  token: string;
  source: TokenSource;
}

async function gh(args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("gh", args, {
      cwd,
      encoding: "utf8",
      timeout: GH_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, ...NON_INTERACTIVE_ENV },
    });
    return stdout;
  } catch {
    return null;
  }
}

/** `https://github.com/acme/widget/pull/42` → owner + repo. */
export function parseRepoFromPrUrl(url: string): { owner: string; repo: string } | null {
  const match = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/\d+/.exec(url.trim());
  if (!match) return null;
  return { owner: match[1]!, repo: match[2]! };
}

const PR_FIELDS = [
  "number",
  "url",
  "title",
  "author",
  "baseRefName",
  "headRefName",
  "headRefOid",
  "isDraft",
].join(",");

export function parsePullRequestJson(raw: string): GitHubPullRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const pr = parsed as Record<string, unknown>;
  const url = typeof pr.url === "string" ? pr.url : "";
  const number = typeof pr.number === "number" ? pr.number : NaN;
  const repo = parseRepoFromPrUrl(url);
  if (!repo || !Number.isInteger(number)) return null;

  const author = pr.author;
  return {
    ...repo,
    number,
    url,
    title: typeof pr.title === "string" ? pr.title : "",
    author:
      author &&
      typeof author === "object" &&
      typeof (author as { login?: unknown }).login === "string"
        ? (author as { login: string }).login
        : "",
    baseRefName: typeof pr.baseRefName === "string" ? pr.baseRefName : "",
    headRefName: typeof pr.headRefName === "string" ? pr.headRefName : "",
    headRefOid: typeof pr.headRefOid === "string" ? pr.headRefOid : "",
    isDraft: pr.isDraft === true,
  };
}

/**
 * The open PR for the checked-out branch, if `gh` can see one.
 *
 * Memoized per repo: `resolveBaseRef` and the GitHub submit target both want
 * this at startup, and neither should pay for a second network round trip.
 */
const prCache = new Map<string, Promise<GitHubPullRequest | null>>();

export function detectPullRequest(repoRoot: string): Promise<GitHubPullRequest | null> {
  const cached = prCache.get(repoRoot);
  if (cached) return cached;
  const pending = (async () => {
    const raw = await gh(["pr", "view", "--json", PR_FIELDS], repoRoot);
    return raw ? parsePullRequestJson(raw) : null;
  })();
  prCache.set(repoRoot, pending);
  return pending;
}

/** Test seam: drop the memoized PR lookups. */
export function clearPullRequestCache(): void {
  prCache.clear();
}

/**
 * A token that can post a review. An explicit env token wins over `gh` so a
 * scoped CI/automation token is never silently replaced by a login session.
 */
export async function resolveGitHubToken(repoRoot: string): Promise<GitHubToken | null> {
  const fromEnv = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (fromEnv?.trim()) return { token: fromEnv.trim(), source: "env" };
  const raw = await gh(["auth", "token"], repoRoot);
  const token = raw?.trim();
  return token ? { token, source: "gh" } : null;
}
