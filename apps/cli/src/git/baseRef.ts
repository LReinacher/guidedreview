import { detectPullRequest } from "../github/gh";
import { GitError, runGit } from "./run";

/** Cap `ls-remote` so a slow or offline remote cannot stall startup. */
const NETWORK_TIMEOUT_MS = 3000;

/** Last resort when the remote never told us its default branch. */
const COMMON_BASE_BRANCHES = ["main", "master", "dev", "develop", "trunk"];

/** Nothing here may prompt: the CLI resolves the base before it owns the terminal. */
const NON_INTERACTIVE_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "echo",
  SSH_ASKPASS: "echo",
};

async function refExists(repoRoot: string, ref: string): Promise<boolean> {
  try {
    await runGit(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repoRoot);
    return true;
  } catch {
    return false;
  }
}

async function firstExisting(repoRoot: string, refs: string[]): Promise<string | null> {
  for (const ref of refs) {
    if (await refExists(repoRoot, ref)) return ref;
  }
  return null;
}

/**
 * A branch name from a PR or a remote HEAD names a branch on the remote, so the
 * remote-tracking ref is the honest comparison; a local branch of the same name
 * may be stale or absent.
 */
function trackingFirst(remote: string | null, branch: string): string[] {
  return remote ? [`${remote}/${branch}`, branch] : [branch];
}

/** The remote this branch pushes to, else `origin`, else whatever exists. */
async function resolveRemote(repoRoot: string, headRef: string): Promise<string | null> {
  let remotes: string[];
  try {
    remotes = (await runGit(["remote"], repoRoot))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
  if (remotes.length === 0) return null;
  if (headRef && headRef !== "HEAD") {
    try {
      const tracked = (await runGit(["config", `branch.${headRef}.remote`], repoRoot)).trim();
      if (tracked && remotes.includes(tracked)) return tracked;
    } catch {
      // branch has no upstream
    }
  }
  return remotes.includes("origin") ? "origin" : remotes[0]!;
}

/**
 * The branch an open PR for the current branch targets. Shares one memoized
 * `gh pr view` with the GitHub submit target, and never throws — `gh` is
 * optional and every failure mode (not installed, logged out, no PR, offline)
 * just means "no PR base".
 */
export async function prBaseBranch(repoRoot: string): Promise<string | null> {
  const pr = await detectPullRequest(repoRoot);
  const name = pr?.baseRefName.trim();
  return name ? name : null;
}

/**
 * The remote's own default branch, for clones that never wrote
 * `<remote>/HEAD` locally (`--single-branch`, `git init` then push, older
 * clones). Without this a repo whose default is `dev` falls through to a stale
 * local `master`.
 */
async function remoteDefaultBranch(repoRoot: string, remote: string): Promise<string | null> {
  try {
    const raw = await runGit(["ls-remote", "--symref", remote, "HEAD"], repoRoot, {
      timeoutMs: NETWORK_TIMEOUT_MS,
      env: { ...process.env, ...NON_INTERACTIVE_ENV },
    });
    return /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(raw)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** `<remote>/HEAD` as recorded locally at clone time, e.g. `origin/dev`. */
async function localRemoteHead(repoRoot: string, remote: string): Promise<string | null> {
  try {
    const resolved = (
      await runGit(["rev-parse", "--abbrev-ref", `${remote}/HEAD`], repoRoot)
    ).trim();
    return resolved && resolved !== `${remote}/HEAD` ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * Pick what this branch should be diffed against, in descending order of how
 * much the answer is actually known: an explicit `--base`, the branch an open
 * PR targets, the remote's default branch, then conventional names.
 */
export async function resolveBaseRef(
  repoRoot: string,
  headRef: string,
  requested?: string,
): Promise<string> {
  if (requested) {
    try {
      await runGit(["rev-parse", "--verify", requested], repoRoot);
      return requested;
    } catch {
      throw new GitError(
        `Base ref "${requested}" does not exist. Pass --base with a real branch or commit.`,
      );
    }
  }

  const remote = await resolveRemote(repoRoot, headRef);

  if (remote && headRef && headRef !== "HEAD") {
    const prBase = await prBaseBranch(repoRoot);
    if (prBase) {
      const ref = await firstExisting(repoRoot, trackingFirst(remote, prBase));
      if (ref) return ref;
    }
  }

  if (remote) {
    const head = await localRemoteHead(repoRoot, remote);
    if (head && (await refExists(repoRoot, head))) return head;

    const fromRemote = await remoteDefaultBranch(repoRoot, remote);
    if (fromRemote) {
      const ref = await firstExisting(repoRoot, trackingFirst(remote, fromRemote));
      if (ref) return ref;
    }
  }

  const tracking = remote ? COMMON_BASE_BRANCHES.map((name) => `${remote}/${name}`) : [];
  const fallback = await firstExisting(repoRoot, [...tracking, ...COMMON_BASE_BRANCHES]);
  if (fallback) return fallback;

  throw new GitError(
    "Could not find a base branch: no open PR, no default branch on the remote, and none of main, master, dev, develop. Pass --base <ref>.",
  );
}
