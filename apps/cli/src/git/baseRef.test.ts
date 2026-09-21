import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { resolveBaseRef } from "./baseRef";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function commit(cwd: string, name: string): Promise<void> {
  await writeFile(path.join(cwd, name), `${name}\n`);
  await git(cwd, ["add", name]);
  await git(cwd, ["commit", "-m", name]);
}

/** An upstream whose default branch is `dev`, cloned into a working copy. */
async function cloneOfDevRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gr-base-"));
  const origin = path.join(dir, "origin");
  await git(dir, ["init", "-b", "dev", "origin"]);
  await git(origin, ["config", "user.email", "test@example.com"]);
  await git(origin, ["config", "user.name", "Test"]);
  await commit(origin, "readme.md");

  const clone = path.join(dir, "clone");
  await git(dir, ["clone", origin, clone]);
  await git(clone, ["config", "user.email", "test@example.com"]);
  await git(clone, ["config", "user.name", "Test"]);
  return clone;
}

describe("resolveBaseRef", () => {
  it("uses the remote default branch over a same-named local branch", async () => {
    const repo = await cloneOfDevRepo();
    await git(repo, ["checkout", "-b", "feat"]);
    await commit(repo, "feat.ts");

    expect(await resolveBaseRef(repo, "feat")).toBe("origin/dev");
  });

  it("prefers the remote default branch over a stale local master", async () => {
    const repo = await cloneOfDevRepo();
    // A leftover `master` used to win: candidates were origin/HEAD, main, master.
    await git(repo, ["branch", "master"]);
    await git(repo, ["checkout", "-b", "feat"]);
    await commit(repo, "feat.ts");

    expect(await resolveBaseRef(repo, "feat")).toBe("origin/dev");
  });

  it("falls back to the remote default branch when the clone never recorded origin/HEAD", async () => {
    const repo = await cloneOfDevRepo();
    await git(repo, ["remote", "set-head", "origin", "--delete"]);
    await git(repo, ["branch", "master"]);
    await git(repo, ["checkout", "-b", "feat"]);
    await commit(repo, "feat.ts");

    expect(await resolveBaseRef(repo, "feat")).toBe("origin/dev");
  });

  it("honours an explicit base and rejects one that does not exist", async () => {
    const repo = await cloneOfDevRepo();
    await git(repo, ["checkout", "-b", "feat"]);
    await commit(repo, "feat.ts");

    expect(await resolveBaseRef(repo, "feat", "origin/dev")).toBe("origin/dev");
    await expect(resolveBaseRef(repo, "feat", "origin/nope")).rejects.toThrow(/does not exist/);
  });
});
