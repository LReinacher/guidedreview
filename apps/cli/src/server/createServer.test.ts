import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { ParsedDiff } from "@guided-review/core";
import { buildLocalReview, type LocalReviewSnapshot } from "../git/localDiff";
import { configPath } from "../config";
import type { CliStatus } from "../banner";
import { createCapturingLogger } from "../log";
import {
  createReviewServer,
  createServerShutdown,
  listen,
  type ReviewSessionPayload,
} from "./createServer";

const execFileAsync = promisify(execFile);

const snapshot: LocalReviewSnapshot = {
  repo: {
    repoRoot: "/tmp/repo",
    gitDir: "/tmp/repo/.git",
    baseRef: "main",
    headRef: "feat",
    mergeBase: "abc",
    includeUntracked: true,
    staged: false,
  },
  commits: [
    {
      sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      shortSha: "aaaaaaa",
      subject: "Add feat",
      body: "",
      author: "Test",
      authoredAt: "2026-01-02T00:00:00Z",
    },
  ],
  scopes: [
    {
      id: "branch",
      label: "feat vs main",
      description: "Committed work",
      meta: "1 commit · 1 file · +1 −0",
      stat: { files: 1, additions: 1, deletions: 0 },
      empty: false,
    },
    {
      id: "uncommitted",
      label: "Uncommitted changes",
      description: "Dirty tree",
      meta: "No changes",
      stat: { files: 0, additions: 0, deletions: 0 },
      empty: true,
    },
    {
      id: "unstaged",
      label: "Unstaged changes",
      description: "Unstaged only",
      meta: "No changes",
      stat: { files: 0, additions: 0, deletions: 0 },
      empty: true,
    },
  ],
  selectedScope: "branch",
  context: {
    source: "local",
    title: "feat",
    description: "Add feat (aaaaaaa)",
    baseRef: "main",
    headRef: "feat",
  },
  diff: {
    files: [
      {
        path: "src/a.ts",
        status: "modified",
        isBinaryOrElided: false,
        hunks: [
          {
            id: "src/a.ts#0",
            header: "@@ -1 +1 @@",
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: [{ type: "add", content: "x", newLine: 1 }],
          },
        ],
      },
    ],
  },
  raw: "",
  sessionKey: "repo:main:feat:branch",
  empty: false,
};

describe("createReviewServer", () => {
  it("re-probes GitHub after a failed credential lookup so connecting mid-review takes effect", async () => {
    const pullRequest = {
      owner: "acme",
      repo: "widget",
      number: 42,
      url: "https://github.com/acme/widget/pull/42",
      title: "Add feat",
      author: "octocat",
      baseRefName: "main",
      headRefName: "feat",
      headRefOid: "head-sha",
      isDraft: false,
    };
    let loggedIn = false;
    let probes = 0;
    const server = createReviewServer({
      snapshot,
      settings: { provider: "anthropic", model: "claude-opus-4-8", apiKey: "" },
      readGitHubTarget: async () => {
        probes += 1;
        return loggedIn
          ? { pullRequest, auth: { login: "octocat" }, reason: null }
          : { pullRequest, auth: null, reason: "No GitHub credentials." };
      },
    });
    const port = await listen(server);
    const base = `http://127.0.0.1:${port}`;

    try {
      expect(await fetch(`${base}/api/github`).then((r) => r.json())).toMatchObject({
        available: false,
      });

      // The user runs `gh auth login` in another terminal and hits Check Again.
      loggedIn = true;
      expect(await fetch(`${base}/api/github`).then((r) => r.json())).toMatchObject({
        available: true,
        login: "octocat",
      });

      // A working answer is then reused rather than re-shelled for every check.
      await fetch(`${base}/api/github`);
      expect(probes).toBe(2);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });

  it("posts the review to the pull request the branch belongs to", async () => {
    const pullRequest = {
      owner: "acme",
      repo: "widget",
      number: 42,
      url: "https://github.com/acme/widget/pull/42",
      title: "Add feat",
      author: "octocat",
      baseRefName: "main",
      headRefName: "feat",
      // Matches the snapshot's branch scope, so no placement warning.
      headRefOid: "head-sha",
      isDraft: false,
    };
    const calls: { url: string; body: unknown }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith("https://api.github.com")) return realFetch(input, init);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (init?.method === "POST") {
        return new Response(
          JSON.stringify({ id: 7, html_url: "https://github.com/acme/widget/pull/42#r7" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ head: { sha: "head-sha" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    const server = createReviewServer({
      snapshot,
      settings: { provider: "anthropic", model: "claude-opus-4-8", apiKey: "" },
      readGitHubTarget: async () => ({
        pullRequest,
        auth: { login: "octocat" },
        reason: null,
      }),
      resolveGitHubToken: async () => ({ token: "tok", source: "gh" as const }),
    });
    const port = await listen(server);
    const base = `http://127.0.0.1:${port}`;

    try {
      const status = await fetch(`${base}/api/github`).then((r) => r.json());
      expect(status).toMatchObject({ available: true, login: "octocat" });

      const result = await fetch(`${base}/api/github/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          body: "Looks good",
          event: "APPROVE",
          comments: [{ path: "src/a.ts", body: "inline note", side: "RIGHT", line: 3 }],
        }),
      }).then((r) => r.json());

      expect(result).toMatchObject({ ok: true, reviewId: 7 });
      const posted = calls.find((call) => call.url.endsWith("/reviews"));
      expect(posted?.body).toMatchObject({
        event: "APPROVE",
        body: "Looks good",
        commit_id: "head-sha",
        comments: [{ path: "src/a.ts", body: "inline note", side: "RIGHT", line: 3 }],
      });
    } finally {
      globalThis.fetch = realFetch;
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });

  it("persists a review under the git dir so a restart resumes it, and never offers GitHub when it is off", async () => {
    const gitDir = await mkdtemp(path.join(os.tmpdir(), "gr-state-"));
    const server = createReviewServer({
      snapshot: { ...snapshot, repo: { ...snapshot.repo, gitDir } },
      settings: { provider: "anthropic", model: "claude-opus-4-8", apiKey: "" },
      github: false,
    });
    const port = await listen(server);
    const base = `http://127.0.0.1:${port}`;
    const key = snapshot.sessionKey;

    const empty = await fetch(`${base}/api/review-state?key=${encodeURIComponent(key)}`);
    expect(await empty.json()).toEqual({ state: null });

    const state = {
      plan: { units: [{ id: "u1" }] },
      draftComments: [
        { id: "d1", target: "github", body: "pending" },
        { id: "d2", target: "local", body: "note" },
      ],
    };
    const saved = await fetch(`${base}/api/review-state`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, state }),
    });
    expect(saved.status).toBe(200);

    // A restarted CLI reads the same key back with both kinds of comment.
    const resumed = await fetch(`${base}/api/review-state?key=${encodeURIComponent(key)}`);
    expect(await resumed.json()).toEqual({ state });

    const github = await fetch(`${base}/api/github`);
    expect(await github.json()).toMatchObject({ enabled: false, available: false });

    const submitted = await fetch(`${base}/api/github/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "hi", event: "COMMENT", comments: [] }),
    });
    expect(await submitted.json()).toMatchObject({ ok: false });

    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it("serves the session and streams no_api_key without a key", async () => {
    const { logger, records } = createCapturingLogger();
    const server = createReviewServer({
      snapshot,
      settings: { provider: "anthropic", model: "claude-opus-4-8", apiKey: "" },
      logger,
    });
    const port = await listen(server);
    const base = `http://127.0.0.1:${port}`;

    const session = await fetch(`${base}/api/session`).then(
      (r) => r.json() as Promise<ReviewSessionPayload>,
    );
    expect(session.diff.files).toHaveLength(1);
    expect(session.settings.hasKey).toBe(false);
    expect(session.selectedScope).toBe("branch");
    expect(session.commits).toHaveLength(1);
    expect(session.scopes).toHaveLength(3);

    const planRes = await fetch(`${base}/api/plan`);
    const body = await planRes.text();
    expect(body.startsWith(":")).toBe(true);
    expect(body).toContain("no_api_key");
    expect(
      records.some(
        (line) =>
          line.level === "info" &&
          (line.label === "http" || line.message.includes("GET /api/session")),
      ),
    ).toBe(false);
    expect(
      records.some((line) => line.label === "session" && line.message.includes("file(s)")),
    ).toBe(false);
    expect(
      records.some((line) => line.label === "plan" && line.message.includes("no API key")),
    ).toBe(true);

    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it("serves image blobs from the current diff and rejects other paths", async () => {
    const root = await mkdir(path.join(os.tmpdir(), `gr-img-srv-${Date.now()}`), {
      recursive: true,
    });
    const cwd = root!;
    const git = (args: string[]) => execFileAsync("git", args, { cwd });
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    await git(["init", "-b", "main"]);
    await git(["config", "user.email", "test@example.com"]);
    await git(["config", "user.name", "Test"]);
    await writeFile(path.join(cwd, "readme.md"), "hello\n");
    await git(["add", "readme.md"]);
    await git(["commit", "-m", "initial"]);
    await git(["checkout", "-b", "feat"]);
    await writeFile(path.join(cwd, "logo.png"), png);
    await git(["add", "logo.png"]);
    await git(["commit", "-m", "add logo"]);

    const live = await buildLocalReview({ cwd, scope: "branch" });
    const server = createReviewServer({
      snapshot: live,
      settings: { provider: "anthropic", model: "claude-opus-4-8", apiKey: "" },
    });
    const port = await listen(server);
    const base = `http://127.0.0.1:${port}`;

    const ok = await fetch(`${base}/api/file?path=logo.png&side=new`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await ok.arrayBuffer()).equals(png)).toBe(true);

    const missing = await fetch(`${base}/api/file?path=readme.md&side=new`);
    expect(missing.status).toBe(404);

    const oldAdded = await fetch(`${base}/api/file?path=logo.png&side=old`);
    expect(oldAdded.status).toBe(404);

    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it("rejects an unknown scope and swaps the session on a real repo", async () => {
    const root = await mkdir(path.join(os.tmpdir(), `gr-srv-${Date.now()}`), { recursive: true });
    const cwd = root!;
    const git = (args: string[]) => execFileAsync("git", args, { cwd });
    await git(["init", "-b", "main"]);
    await git(["config", "user.email", "test@example.com"]);
    await git(["config", "user.name", "Test"]);
    await writeFile(path.join(cwd, "readme.md"), "hello\n");
    await git(["add", "readme.md"]);
    await git(["commit", "-m", "initial"]);
    await git(["checkout", "-b", "feat"]);
    await writeFile(path.join(cwd, "feat.ts"), "export const n = 1;\n");
    await git(["add", "feat.ts"]);
    await git(["commit", "-m", "add feat"]);
    await writeFile(path.join(cwd, "dirty.ts"), "export const d = 1;\n");

    const live = await buildLocalReview({ cwd });
    const server = createReviewServer({
      snapshot: live,
      settings: { provider: "anthropic", model: "claude-opus-4-8", apiKey: "" },
    });
    const port = await listen(server);
    const base = `http://127.0.0.1:${port}`;

    const unknown = await fetch(`${base}/api/diff`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "nope" }),
    });
    expect(unknown.status).toBe(400);

    const switched = await fetch(`${base}/api/diff`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "uncommitted" }),
    }).then((r) => r.json() as Promise<ReviewSessionPayload>);
    expect(switched.selectedScope).toBe("uncommitted");
    expect(switched.diff.files.map((file) => file.path)).toContain("dirty.ts");
    expect(switched.diff.files.map((file) => file.path)).not.toContain("feat.ts");

    const session = await fetch(`${base}/api/session`).then(
      (r) => r.json() as Promise<{ selectedScope: string; diff: ParsedDiff }>,
    );
    expect(session.selectedScope).toBe("uncommitted");
    expect(session.diff.files.map((file) => file.path)).toContain("dirty.ts");

    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it("reports a changed working tree without swapping the snapshot until session reload", async () => {
    const root = await mkdir(path.join(os.tmpdir(), `gr-hash-${Date.now()}`), { recursive: true });
    const cwd = root!;
    const git = (args: string[]) => execFileAsync("git", args, { cwd });
    await git(["init", "-b", "main"]);
    await git(["config", "user.email", "test@example.com"]);
    await git(["config", "user.name", "Test"]);
    await writeFile(path.join(cwd, "readme.md"), "hello\n");
    await git(["add", "readme.md"]);
    await git(["commit", "-m", "initial"]);
    await git(["checkout", "-b", "feat"]);
    await writeFile(path.join(cwd, "feat.ts"), "export const n = 1;\n");
    await git(["add", "feat.ts"]);
    await git(["commit", "-m", "add feat"]);

    const live = await buildLocalReview({ cwd, scope: "branch" });
    const { logger, records } = createCapturingLogger();
    const patches: Partial<CliStatus>[] = [];
    const server = createReviewServer({
      snapshot: live,
      settings: { provider: "anthropic", model: "claude-opus-4-8", apiKey: "" },
      logger,
      onStatus: (patch) => patches.push(patch),
    });
    const port = await listen(server);
    const base = `http://127.0.0.1:${port}`;

    const before = await fetch(`${base}/api/diff-status`).then(
      (r) => r.json() as Promise<{ changed: boolean; hash: string }>,
    );
    expect(before.changed).toBe(false);
    expect(patches.some((patch) => patch.diffFresh === "up to date")).toBe(true);

    await writeFile(path.join(cwd, "feat.ts"), "export const n = 2;\n");
    await git(["add", "feat.ts"]);
    await git(["commit", "-m", "edit feat"]);

    const status = await fetch(`${base}/api/diff-status`).then(
      (r) => r.json() as Promise<{ changed: boolean; hash: string }>,
    );
    expect(status.changed).toBe(true);
    expect(status.hash).not.toBe(before.hash);

    const plan = await fetch(`${base}/api/plan`).then((r) => r.text());
    expect(plan).toContain("no_api_key");

    const reloaded = await fetch(`${base}/api/session`).then(
      (r) => r.json() as Promise<ReviewSessionPayload>,
    );
    expect(reloaded.diffHash).toBe(status.hash);
    expect(
      patches.some(
        (patch) =>
          patch.files === reloaded.diff.files.length &&
          patch.scope === "branch" &&
          patch.lastPullAt instanceof Date,
      ),
    ).toBe(true);
    expect(
      records.some(
        (line) =>
          line.level === "info" &&
          line.label === "http" &&
          line.message.includes("GET /api/diff-status"),
      ),
    ).toBe(false);
    expect(
      reloaded.diff.files.some((file) =>
        file.hunks.some((h) => h.lines.some((line) => line.content.includes("n = 2"))),
      ),
    ).toBe(true);

    const after = await fetch(`${base}/api/diff-status`).then(
      (r) => r.json() as Promise<{ changed: boolean }>,
    );
    expect(after.changed).toBe(false);

    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it("shuts down once under repeated signals without stacking close listeners", async () => {
    const server = createReviewServer({
      snapshot,
      settings: { provider: "anthropic", model: "claude-opus-4-8", apiKey: "" },
    });
    const port = await listen(server);

    // Hold an open socket so close would otherwise hang (same class of problem as SSE).
    const held = await new Promise<net.Socket>((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1", () => resolve(socket));
      socket.on("error", reject);
    });

    let closeCalls = 0;
    const realClose = server.close.bind(server);
    server.close = ((cb?: (err?: Error) => void) => {
      closeCalls += 1;
      return realClose(cb);
    }) as typeof server.close;

    const exits: number[] = [];
    const shutdown = createServerShutdown(server, (code) => {
      exits.push(code);
    });

    shutdown();
    shutdown();
    shutdown();

    expect(closeCalls).toBe(1);
    expect(server.listenerCount("close")).toBeLessThanOrEqual(1);
    // Second and third signals force-exit instead of stacking more close listeners.
    expect(exits.filter((code) => code === 1)).toHaveLength(2);

    held.destroy();
    await new Promise<void>((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      realClose(() => resolve());
      server.closeAllConnections();
    });
  });

  describe("PUT /api/settings", () => {
    const prevConfigDir = process.env.GUIDED_REVIEW_CONFIG_DIR;

    afterEach(() => {
      if (prevConfigDir === undefined) delete process.env.GUIDED_REVIEW_CONFIG_DIR;
      else process.env.GUIDED_REVIEW_CONFIG_DIR = prevConfigDir;
    });

    async function withTempConfig(): Promise<string> {
      const dir = await mkdir(path.join(os.tmpdir(), `gr-cfg-${Date.now()}`), { recursive: true });
      process.env.GUIDED_REVIEW_CONFIG_DIR = dir!;
      return dir!;
    }

    it("keeps agent auth in memory and does not persist the secret", async () => {
      const dir = await withTempConfig();
      const server = createReviewServer({
        snapshot,
        settings: {
          provider: "grok",
          model: "grok-4.5",
          apiKey: "session-jwt",
          authScheme: "bearer",
        },
        codingAgent: "grok",
      });
      const port = await listen(server);
      const base = `http://127.0.0.1:${port}`;

      const saved = await fetch(`${base}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "grok", model: "grok-4.6" }),
      }).then((r) => r.json() as Promise<{ codingAgent: string | null; hasKey: boolean }>);
      expect(saved.codingAgent).toBe("grok");
      expect(saved.hasKey).toBe(true);

      const file = JSON.parse(await readFile(path.join(dir, "config.json"), "utf8")) as {
        apiKey?: string;
        codingAgent?: string;
        model?: string;
      };
      expect(file.apiKey).toBeUndefined();
      expect(file.codingAgent).toBeUndefined();
      expect(file.model).toBe("grok-4.6");

      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    });

    it("stores a pasted key and clears the coding agent", async () => {
      await withTempConfig();
      const server = createReviewServer({
        snapshot,
        settings: {
          provider: "grok",
          model: "grok-4.5",
          apiKey: "session-jwt",
          authScheme: "bearer",
        },
        codingAgent: "grok",
      });
      const port = await listen(server);
      const base = `http://127.0.0.1:${port}`;

      const saved = await fetch(`${base}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "openai",
          model: "gpt-4.1",
          apiKey: "sk-user",
        }),
      }).then((r) => r.json() as Promise<{ codingAgent: string | null; last4: string | null }>);
      expect(saved.codingAgent).toBeNull();
      expect(saved.last4).toBe("user");

      const file = JSON.parse(await readFile(configPath(), "utf8")) as {
        apiKey?: string;
        codingAgent?: string;
        provider?: string;
      };
      expect(file.apiKey).toBe("sk-user");
      expect(file.codingAgent).toBeUndefined();
      expect(file.provider).toBe("openai");

      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    });

    it("rejects invalid JSON with 400", async () => {
      const server = createReviewServer({
        snapshot,
        settings: { provider: "anthropic", model: "claude-opus-4-8", apiKey: "" },
      });
      const port = await listen(server);
      const res = await fetch(`http://127.0.0.1:${port}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{",
      });
      expect(res.status).toBe(400);
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    });

    it("switches to a detected coding agent and drops the stored key", async () => {
      const dir = await withTempConfig();
      await writeFile(
        path.join(dir, "config.json"),
        JSON.stringify({ provider: "openai", apiKey: "sk-old" }),
        "utf8",
      );
      const server = createReviewServer({
        snapshot,
        settings: { provider: "openai", model: "gpt-4.1", apiKey: "sk-old" },

        detectAgents: async () => [
          {
            id: "codex",
            displayName: "Codex",
            provider: "openai",
            auth: {
              provider: "openai",
              secret: "sk-agent-secret",
              kind: "api_key",
              usableForReview: true,
              model: "gpt-5",
            },
          },
        ],
      });
      const port = await listen(server);
      const saved = await fetch(`http://127.0.0.1:${port}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ codingAgent: "codex" }),
      }).then(
        (r) =>
          r.json() as Promise<{
            codingAgent: string | null;
            last4: string | null;
            hasKey: boolean;
          }>,
      );
      expect(saved.codingAgent).toBe("codex");
      expect(saved.hasKey).toBe(true);
      expect(saved.last4).toBe("cret");

      const file = JSON.parse(await readFile(configPath(), "utf8")) as {
        apiKey?: string;
        codingAgent?: string;
      };
      expect(file.codingAgent).toBe("codex");
      expect(file.apiKey).toBeUndefined();

      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    });

    it("rejects an unknown coding agent", async () => {
      const server = createReviewServer({
        snapshot,
        settings: { provider: "anthropic", model: "claude-opus-4-8", apiKey: "" },

        detectAgents: async () => [],
      });
      const port = await listen(server);
      const res = await fetch(`http://127.0.0.1:${port}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ codingAgent: "codex" }),
      });
      expect(res.status).toBe(400);
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    });
  });

  describe("GET /api/agents", () => {
    it("returns detected agents without secrets", async () => {
      const server = createReviewServer({
        snapshot,
        settings: { provider: "anthropic", model: "claude-opus-4-8", apiKey: "" },

        detectAgents: async () => [
          {
            id: "claude-code",
            displayName: "Claude Code",
            provider: "anthropic",
            auth: {
              provider: "anthropic",
              secret: "",
              kind: "cli",
              usableForReview: true,
            },
          },
        ],
      });
      const port = await listen(server);
      const body = await fetch(`http://127.0.0.1:${port}/api/agents`).then(
        (r) =>
          r.json() as Promise<{
            agents: { id: string; displayName: string; usable: boolean }[];
          }>,
      );
      expect(body.agents).toEqual([
        {
          id: "claude-code",
          displayName: "Claude Code",
          provider: "anthropic",
          installed: true,
          usable: true,
          reason: null,
        },
        {
          id: "codex",
          displayName: "Codex",
          provider: "openai",
          installed: false,
          usable: false,
          reason: "Codex is not installed.",
        },
        {
          id: "grok",
          displayName: "Grok",
          provider: "grok",
          installed: false,
          usable: false,
          reason: "Grok is not installed.",
        },
      ]);
      expect(JSON.stringify(body)).not.toContain("sk-ant");

      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    });
  });

  describe("POST /api/settings/test", () => {
    const prevConfigDir = process.env.GUIDED_REVIEW_CONFIG_DIR;

    afterEach(() => {
      if (prevConfigDir === undefined) delete process.env.GUIDED_REVIEW_CONFIG_DIR;
      else process.env.GUIDED_REVIEW_CONFIG_DIR = prevConfigDir;
    });

    it("returns ok when the probe succeeds", async () => {
      const dir = await mkdir(path.join(os.tmpdir(), `gr-cfg-${Date.now()}`), { recursive: true });
      process.env.GUIDED_REVIEW_CONFIG_DIR = dir!;
      const calls: string[] = [];
      const server = createReviewServer({
        snapshot,
        settings: { provider: "anthropic", model: "claude-opus-4-8", apiKey: "sk-old" },

        testConnection: async (next) => {
          calls.push(next.apiKey);
        },
      });
      const port = await listen(server);
      const body = await fetch(`http://127.0.0.1:${port}/api/settings/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "openai", model: "gpt-4.1", apiKey: "sk-new" }),
      }).then((r) => r.json() as Promise<{ ok: boolean }>);
      expect(body).toEqual({ ok: true });
      expect(calls).toEqual(["sk-new"]);
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    });

    it("returns a user-facing error when the probe fails", async () => {
      const dir = await mkdir(path.join(os.tmpdir(), `gr-cfg-${Date.now()}`), { recursive: true });
      process.env.GUIDED_REVIEW_CONFIG_DIR = dir!;
      const server = createReviewServer({
        snapshot,
        settings: { provider: "anthropic", model: "claude-opus-4-8", apiKey: "sk-bad" },

        testConnection: async () => {
          throw new Error("Invalid API key");
        },
      });
      const port = await listen(server);
      const res = await fetch(`http://127.0.0.1:${port}/api/settings/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: false, error: "Invalid API key" });
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    });
  });

  it("serves index.html when staticDir sits under a dot-segment path", async () => {
    // Mimics global installs under ~/.nvm or ~/.npm — absolute sendFile without
    // `root` treats those segments as dotfiles and 404s.
    const root = await mkdir(path.join(os.tmpdir(), `gr-ui-${Date.now()}`, ".fakenvm", "ui"), {
      recursive: true,
    });
    const staticDir = root!;
    await writeFile(path.join(staticDir, "index.html"), "<!doctype html><title>ok</title>\n");

    const server = createReviewServer({
      snapshot,
      settings: { provider: "anthropic", model: "claude-opus-4-8", apiKey: "" },
      staticDir,
    });
    const port = await listen(server);
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>ok</title>");

    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });
});
