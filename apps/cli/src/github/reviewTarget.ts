/**
 * Whether this local review can be posted to GitHub as a pull request review,
 * and what to warn the user about before it is.
 */

import type { DiffScopeId, LocalReviewSnapshot } from "../git/localDiff";
import { runGit } from "../git/run";
import { detectPullRequest, resolveGitHubToken, type GitHubPullRequest } from "./gh";

const API_VERSION = "2022-11-28";

export const GH_RECONNECT_HINT =
  "Run `gh auth login` (or set GITHUB_TOKEN) and restart guidedreview.";

export interface GitHubUser {
  login: string;
  name?: string;
  avatarUrl?: string;
}

export interface GitHubTargetStatus {
  /** The PR this branch would post to, or null when there is none. */
  pullRequest: GitHubPullRequest | null;
  /** Identity behind the resolved token; null when unauthenticated. */
  auth: GitHubUser | null;
  /** Why submitting is unavailable, in the user's terms. Null when it works. */
  reason: string | null;
}

/** The account the token belongs to. Doubles as a token validity check. */
export async function fetchGitHubUser(token: string): Promise<GitHubUser | null> {
  let response: Response;
  try {
    response = await fetch("https://api.github.com/user", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": API_VERSION,
      },
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const login = body && typeof body.login === "string" ? body.login : "";
  if (!login) return null;
  return {
    login,
    ...(typeof body?.name === "string" ? { name: body.name } : {}),
    ...(typeof body?.avatar_url === "string" ? { avatarUrl: body.avatar_url } : {}),
  };
}

export async function readGitHubTarget(repoRoot: string): Promise<GitHubTargetStatus> {
  const [pullRequest, credentials] = await Promise.all([
    detectPullRequest(repoRoot),
    resolveGitHubToken(repoRoot),
  ]);

  if (!pullRequest) {
    return {
      pullRequest: null,
      auth: null,
      reason:
        "No open pull request for this branch. Push the branch and open a PR to submit a GitHub review.",
    };
  }
  if (!credentials) {
    return {
      pullRequest,
      auth: null,
      reason: `No GitHub credentials. ${GH_RECONNECT_HINT}`,
    };
  }
  const auth = await fetchGitHubUser(credentials.token);
  if (!auth) {
    return {
      pullRequest,
      auth: null,
      reason: `GitHub rejected the ${credentials.source === "env" ? "GITHUB_TOKEN" : "gh"} token. ${GH_RECONNECT_HINT}`,
    };
  }
  return { pullRequest, auth, reason: null };
}

async function headSha(repoRoot: string): Promise<string | null> {
  try {
    return (await runGit(["rev-parse", "HEAD"], repoRoot)).trim() || null;
  } catch {
    return null;
  }
}

/**
 * GitHub anchors review comments to the PR's head commit. Any scope that is
 * not "this branch at exactly the pushed head" can therefore put a comment on
 * the wrong line — or get it rejected. Say so before the user submits rather
 * than letting GitHub answer with a 422.
 */
export async function commentAlignmentWarning(
  snapshot: LocalReviewSnapshot,
  pullRequest: GitHubPullRequest,
): Promise<string | null> {
  const scope: DiffScopeId = snapshot.selectedScope;

  if (scope === "uncommitted" || scope === "unstaged") {
    return `These changes are not part of ${pullRequest.headRefName} on GitHub yet. Commit and push them, or inline comments will be rejected or land on the wrong lines.`;
  }

  if (scope.startsWith("commit:")) {
    return "You are reviewing a single commit. GitHub anchors comments to the pull request head, so lines that later commits changed may not match.";
  }

  const local = await headSha(snapshot.repo.repoRoot);
  if (local && pullRequest.headRefOid && local !== pullRequest.headRefOid) {
    return `Your local HEAD (${local.slice(0, 7)}) differs from the pull request head (${pullRequest.headRefOid.slice(0, 7)}). Push this branch before submitting so comments land on the right lines.`;
  }

  return null;
}
