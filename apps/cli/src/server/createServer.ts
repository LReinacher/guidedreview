import { existsSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import {
  annotateReview,
  describeErrorMessage,
  isSymbolName,
  submitPullRequestReview,
  type AnnotateReviewStreamEvent,
  type ProviderSettings,
  type ReviewCommentInput,
  type ReviewEvent,
} from "@guided-review/core";
import {
  applyDetectedAgent,
  applyProviderSettings,
  publicAgents,
  publicSettings,
  patchConfigFile,
  type PublicCliSettings,
} from "../config";
import {
  canGenerateReview,
  createDefaultAgentIo,
  detectAll,
  isCodingAgentId,
  reviewClientFor,
  type CodingAgentId,
  type DetectedAgent,
} from "../codingAgents";
import {
  currentDiffHash,
  hashDiff,
  isDiffScopeId,
  rebuildLocalReview,
  type DiffScopeOption,
  type LocalCommit,
  type LocalReviewSnapshot,
} from "../git/localDiff";
import {
  isFilePreviewSide,
  isReadablePath,
  readReviewFileLineCount,
  readReviewFileLines,
  readReviewImage,
  readWorktreeTextFile,
} from "../git/fileBlob";
import { findSymbolDefinitions } from "../git/symbolSearch";
import { GitError } from "../git/run";
import {
  resolveGitHubToken as resolveGitHubTokenFromMachine,
  type GitHubPullRequest,
  type GitHubToken,
} from "../github/gh";
import {
  commentAlignmentWarning,
  readGitHubTarget as readGitHubTargetForRepo,
  GH_RECONNECT_HINT,
  type GitHubTargetStatus,
} from "../github/reviewTarget";
import { deleteReviewSession, readReviewSession, writeReviewSession } from "../review/sessionStore";
import type { CliStatus } from "../banner";
import { createLogger, labeled } from "../log";
import type { Logger } from "winston";

function describePlanEvent(event: AnnotateReviewStreamEvent): string | null {
  switch (event.type) {
    case "STATUS":
      return event.phase;
    case "UNIT":
      return `unit ${event.unit.id} (${event.unit.files.length} file(s))`;
    case "DONE":
      return `done ${event.plan.units.length} unit(s)`;
    case "ERROR": {
      const parts = [
        event.error.statusCode !== undefined ? String(event.error.statusCode) : null,
        event.error.code,
        event.error.message,
      ].filter((part): part is string => Boolean(part));
      return parts.join(" ");
    }
  }
}

/** What the browser needs to decide whether Submit Review is on the table. */
export interface GitHubStatusPayload {
  /** False when the CLI was started with --no-github. */
  enabled: boolean;
  /** A PR exists and the token works — Submit Review can be offered. */
  available: boolean;
  pullRequest: GitHubPullRequest | null;
  login: string | null;
  /** Why submitting is unavailable, in the user's terms. */
  reason: string | null;
  /** Non-blocking caution about comment placement for the current scope. */
  warning: string | null;
}

/** One file's text for the source viewer tab. */
export interface SourceFilePayload {
  path: string;
  lines: string[];
  /** True when the file was longer than the viewer will serve. */
  truncated: boolean;
}

export interface ReviewSessionPayload {
  context: LocalReviewSnapshot["context"];
  diff: LocalReviewSnapshot["diff"];
  sessionKey: string;
  diffHash: string;
  settings: ReturnType<typeof publicSettings>;
  commits: LocalCommit[];
  scopes: DiffScopeOption[];
  selectedScope: LocalReviewSnapshot["selectedScope"];
}

export interface CreateReviewServerOptions {
  snapshot: LocalReviewSnapshot;
  settings: ProviderSettings;
  codingAgent?: CodingAgentId | null;
  /** Offer posting the review to the branch's pull request. Default true. */
  github?: boolean;
  staticDir?: string;
  logger?: Logger;
  onStatus?: (patch: Partial<CliStatus>) => void;
  detectAgents?: () => Promise<DetectedAgent[]>;
  testConnection?: (settings: ProviderSettings) => Promise<void>;
  /** Test seam for the `gh` lookups behind Submit Review. */
  readGitHubTarget?: (repoRoot: string) => Promise<GitHubTargetStatus>;
  /** Test seam for the credentials Submit Review posts with. */
  resolveGitHubToken?: (repoRoot: string) => Promise<GitHubToken | null>;
}

interface SettingsBody {
  provider?: ProviderSettings["provider"];
  model?: string;
  apiKey?: string;
  codingAgent?: CodingAgentId | null;
}

type RequestWithRaw = Request & { rawBody?: Buffer };

function sendJson(res: Response, status: number, body: unknown): void {
  res.status(status).set("cache-control", "no-store").json(body);
}

function readJsonBody(req: Request): { ok: true; value: unknown } | { ok: false } {
  const raw = (req as RequestWithRaw).rawBody;
  if (!raw || !raw.toString("utf8").trim()) return { ok: false };
  return { ok: true, value: req.body as unknown };
}

function sessionPayload(
  snapshot: LocalReviewSnapshot,
  settings: ReturnType<typeof publicSettings>,
): ReviewSessionPayload {
  return {
    context: snapshot.context,
    diff: snapshot.diff,
    sessionKey: snapshot.sessionKey,
    diffHash: hashDiff(snapshot.raw),
    settings,
    commits: snapshot.commits,
    scopes: snapshot.scopes,
    selectedScope: snapshot.selectedScope,
  };
}

function sessionStatus(
  snapshot: LocalReviewSnapshot,
  published: ReturnType<typeof publicSettings>,
): Partial<CliStatus> {
  return {
    files: snapshot.diff.files.length,
    scope: snapshot.selectedScope,
    headRef: snapshot.context.headRef,
    baseRef: snapshot.context.baseRef,
    provider: published.provider,
    model: published.model,
    agent: published.codingAgent ?? null,
    ready: published.ready,
  };
}

function queryString(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return "";
}

const REVIEW_EVENTS: ReviewEvent[] = ["COMMENT", "APPROVE", "REQUEST_CHANGES"];

interface SubmitReviewBody {
  body: string;
  event: ReviewEvent;
  comments: ReviewCommentInput[];
}

/**
 * Comments arrive from the local UI, but they are forwarded verbatim to
 * GitHub, so only the fields the API accepts are copied through.
 */
function parseReviewComment(value: unknown): ReviewCommentInput | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.path !== "string" || !raw.path) return null;
  if (typeof raw.body !== "string" || !raw.body) return null;
  const comment: ReviewCommentInput = { path: raw.path, body: raw.body };
  if (raw.subjectType === "file") {
    comment.subjectType = "file";
    return comment;
  }
  if (raw.side === "LEFT" || raw.side === "RIGHT") comment.side = raw.side;
  if (typeof raw.line === "number") comment.line = raw.line;
  if (typeof raw.startLine === "number") comment.startLine = raw.startLine;
  if (raw.startSide === "LEFT" || raw.startSide === "RIGHT") comment.startSide = raw.startSide;
  return comment;
}

function parseSubmitReviewBody(value: unknown): SubmitReviewBody | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const event = raw.event;
  if (typeof event !== "string" || !REVIEW_EVENTS.includes(event as ReviewEvent)) return null;
  if (typeof raw.body !== "string") return null;
  const comments = Array.isArray(raw.comments) ? raw.comments.map(parseReviewComment) : [];
  if (comments.some((comment) => comment === null)) return null;
  return {
    body: raw.body,
    event: event as ReviewEvent,
    comments: comments as ReviewCommentInput[],
  };
}

function parseSettingsBody(value: unknown): SettingsBody | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const body: SettingsBody = {};
  if (typeof raw.provider === "string") {
    body.provider = raw.provider as ProviderSettings["provider"];
  }
  if (typeof raw.model === "string") body.model = raw.model;
  if (typeof raw.apiKey === "string") body.apiKey = raw.apiKey;
  if (raw.codingAgent === null) body.codingAgent = null;
  else if (typeof raw.codingAgent === "string") {
    if (!isCodingAgentId(raw.codingAgent)) return null;
    body.codingAgent = raw.codingAgent;
  }
  return body;
}

export function createReviewServer(options: CreateReviewServerOptions) {
  let settings = options.settings;
  let codingAgent = options.codingAgent ?? null;
  let snapshot = options.snapshot;
  const logger = options.logger ?? createLogger({ silent: true });
  const onStatus = options.onStatus;
  const httpLog = labeled(logger, "http");
  const sessionLog = labeled(logger, "session");
  const settingsLog = labeled(logger, "settings");
  const diffLog = labeled(logger, "diff");
  const planLog = labeled(logger, "plan");
  const uiLog = labeled(logger, "ui");
  const detectAgents = options.detectAgents ?? (() => detectAll(createDefaultAgentIo()));
  const testConnection =
    options.testConnection ??
    ((next: ProviderSettings) => reviewClientFor(next, codingAgent).testConnection(next));
  const staticDir =
    options.staticDir ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "ui");
  const githubEnabled = options.github !== false;
  const readGitHubTarget = options.readGitHubTarget ?? readGitHubTargetForRepo;
  const resolveGitHubToken = options.resolveGitHubToken ?? resolveGitHubTokenFromMachine;
  const githubLog = labeled(logger, "github");
  const stateLog = labeled(logger, "state");
  /**
   * PR + token identity. Costs a `gh` call and an API round trip, so a working
   * answer is kept for the life of the review — but a failure is not, or
   * running `gh auth login` in another terminal could never take effect.
   */
  let githubTarget: GitHubTargetStatus | null = null;

  async function githubStatus(): Promise<GitHubStatusPayload> {
    if (!githubEnabled) {
      return {
        enabled: false,
        available: false,
        pullRequest: null,
        login: null,
        reason: "GitHub submission is off (--no-github).",
        warning: null,
      };
    }
    const target = githubTarget ?? (await readGitHubTarget(snapshot.repo.repoRoot));
    const available = Boolean(target.pullRequest && target.auth);
    if (available) githubTarget = target;
    return {
      enabled: true,
      available,
      pullRequest: target.pullRequest,
      login: target.auth?.login ?? null,
      reason: target.reason,
      warning:
        available && target.pullRequest
          ? await commentAlignmentWarning(snapshot, target.pullRequest)
          : null,
    };
  }

  async function applySettingsBody(
    body: SettingsBody,
  ): Promise<{ ok: true; published: PublicCliSettings } | { ok: false; error: string }> {
    const hasNewKey = typeof body.apiKey === "string" && body.apiKey.length > 0;
    if (body.codingAgent && !hasNewKey) {
      const detected = await detectAgents();
      const agent = detected.find((item) => item.id === body.codingAgent);
      if (!agent) return { ok: false, error: "That coding agent is not installed." };
      try {
        const applied = applyDetectedAgent(agent, body.model);
        settings = applied.settings;
        codingAgent = applied.codingAgent;
        await patchConfigFile(applied.persist);
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : "Could not use that coding agent.",
        };
      }
    } else {
      const applied = applyProviderSettings(settings, codingAgent, body);
      if (body.codingAgent === null && !hasNewKey) {
        applied.codingAgent = null;
        applied.persist.codingAgent = null;
      }
      settings = applied.settings;
      codingAgent = applied.codingAgent;
      await patchConfigFile(applied.persist);
    }
    return { ok: true, published: publicSettings(settings, codingAgent) };
  }

  const app = express();
  app.disable("x-powered-by");
  app.use(
    express.json({
      // A persisted review carries its whole diff and plan, which routinely
      // beats the 100kb default. This server only ever listens on loopback.
      limit: "64mb",
      verify: (req, _res, buf) => {
        (req as RequestWithRaw).rawBody = buf;
      },
    }),
  );

  app.use((req, res, next) => {
    if (!req.path.startsWith("/api/")) {
      next();
      return;
    }
    const started = Date.now();
    res.on("finish", () => {
      const line = `${req.method} ${req.path} ${res.statusCode} ${Date.now() - started}ms`;
      if (res.statusCode >= 400) httpLog.warn(line);
      else httpLog.debug(line);
    });
    next();
  });

  app.get("/api/session", async (_req, res) => {
    try {
      snapshot = await rebuildLocalReview(snapshot.repo, snapshot.selectedScope);
      const published = publicSettings(settings, codingAgent);
      onStatus?.({
        ...sessionStatus(snapshot, published),
        lastPullAt: new Date(),
        diffFresh: "up to date",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sessionLog.warn(`rebuild failed, serving last snapshot  ${message}`);
    }
    const published = publicSettings(settings, codingAgent);
    sendJson(res, 200, sessionPayload(snapshot, published));
  });

  app.get("/api/diff-status", async (_req, res) => {
    try {
      const hash = await currentDiffHash(snapshot.repo, snapshot.selectedScope);
      const served = hashDiff(snapshot.raw);
      const changed = hash !== served;
      onStatus?.({ diffFresh: changed ? "changed" : "up to date" });
      sendJson(res, 200, { hash, changed });
    } catch (error) {
      const message =
        error instanceof GitError ? error.message : "Could not check the current diff.";
      sendJson(res, 500, { error: message });
    }
  });

  app.get("/api/settings", (_req, res) => {
    sendJson(res, 200, publicSettings(settings, codingAgent));
  });

  app.put("/api/settings", async (req, res) => {
    const parsed = readJsonBody(req);
    if (!parsed.ok) {
      sendJson(res, 400, { error: "Request body must be JSON." });
      return;
    }
    const body = parseSettingsBody(parsed.value);
    if (!body) {
      sendJson(res, 400, { error: "Request body must be JSON." });
      return;
    }
    const applied = await applySettingsBody(body);
    if (!applied.ok) {
      sendJson(res, 400, { error: applied.error });
      return;
    }
    const published = applied.published;
    settingsLog.info(
      `${published.provider}/${published.model}  key=${published.hasKey ? "yes" : "no"}${published.codingAgent ? `  agent=${published.codingAgent}` : ""}`,
    );
    onStatus?.({
      provider: published.provider,
      model: published.model,
      agent: published.codingAgent ?? null,
      ready: published.ready,
    });
    sendJson(res, 200, published);
  });

  app.post("/api/settings/test", async (req, res) => {
    const parsed = readJsonBody(req);
    if (!parsed.ok) {
      sendJson(res, 400, { error: "Request body must be JSON." });
      return;
    }
    const body = parseSettingsBody(parsed.value);
    if (!body) {
      sendJson(res, 400, { error: "Request body must be JSON." });
      return;
    }
    const applied = await applySettingsBody(body);
    if (!applied.ok) {
      sendJson(res, 400, { error: applied.error });
      return;
    }
    if (!canGenerateReview(settings, codingAgent)) {
      sendJson(res, 200, { ok: false, error: "No API key configured." });
      return;
    }
    try {
      await testConnection(settings);
      settingsLog.info(`test ok  ${settings.provider}/${settings.model}`);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      const message = describeErrorMessage(error);
      settingsLog.warn(`test fail  ${message}`);
      sendJson(res, 200, { ok: false, error: message });
    }
  });

  app.get("/api/agents", async (_req, res) => {
    const detected = await detectAgents();
    sendJson(res, 200, { agents: publicAgents(detected) });
  });

  app.get("/api/file", async (req, res) => {
    const filePath = queryString(req.query.path);
    const side = queryString(req.query.side);
    if (!filePath || !side || !isFilePreviewSide(side)) {
      sendJson(res, 400, { error: "path and side=old|new are required." });
      return;
    }
    try {
      const blob = await readReviewImage(snapshot, filePath, side);
      if (!blob) {
        sendJson(res, 404, { error: "No preview for that file." });
        return;
      }
      res.status(200);
      res.set({
        "content-type": blob.mime,
        "content-length": String(blob.bytes.byteLength),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      res.end(blob.bytes);
    } catch (error) {
      const message = error instanceof GitError ? error.message : "Could not read that file.";
      sendJson(res, 400, { error: message });
    }
  });

  app.get("/api/file-lines", async (req, res) => {
    const filePath = queryString(req.query.path);
    const side = queryString(req.query.side);
    const start = Number(queryString(req.query.start));
    const end = Number(queryString(req.query.end));
    if (
      !filePath ||
      !isFilePreviewSide(side) ||
      !Number.isInteger(start) ||
      !Number.isInteger(end)
    ) {
      sendJson(res, 400, { error: "path, side=old|new, start and end are required." });
      return;
    }
    try {
      const lines = await readReviewFileLines(snapshot, filePath, side, start, end);
      if (!lines) {
        sendJson(res, 404, { error: "No text available for that file." });
        return;
      }
      sendJson(res, 200, { lines });
    } catch (error) {
      const message = error instanceof GitError ? error.message : "Could not read that file.";
      sendJson(res, 400, { error: message });
    }
  });

  app.get("/api/file-line-count", async (req, res) => {
    const filePath = queryString(req.query.path);
    const side = queryString(req.query.side);
    if (!filePath || !isFilePreviewSide(side)) {
      sendJson(res, 400, { error: "path and side=old|new are required." });
      return;
    }
    try {
      const totalLines = await readReviewFileLineCount(snapshot, filePath, side);
      if (totalLines == null) {
        sendJson(res, 404, { error: "No text available for that file." });
        return;
      }
      sendJson(res, 200, { totalLines });
    } catch (error) {
      const message = error instanceof GitError ? error.message : "Could not read that file.";
      sendJson(res, 400, { error: message });
    }
  });

  app.get("/api/definition", async (req, res) => {
    const symbol = queryString(req.query.symbol);
    const fromPath = queryString(req.query.path);
    if (!symbol || !fromPath) {
      sendJson(res, 400, { error: "symbol and path are required." });
      return;
    }
    if (!isSymbolName(symbol)) {
      sendJson(res, 400, { error: "That is not an identifier." });
      return;
    }
    // The line the click was on, so a parameter or local in scope wins over a
    // same-named declaration on the other side of the repo. Optional: a click
    // on a revealed context line has no line number to send.
    const line = Number(queryString(req.query.line));
    try {
      const definitions = await findSymbolDefinitions(
        snapshot.repo.repoRoot,
        symbol,
        fromPath,
        Number.isInteger(line) && line > 0 ? line : undefined,
      );
      sendJson(res, 200, { definitions });
    } catch (error) {
      const message =
        error instanceof GitError ? error.message : "Could not search for that symbol.";
      sendJson(res, 400, { error: message });
    }
  });

  // Whole-file text for the viewer a declaration opens in a new tab. Scoped to
  // files git knows about, so an ignored secret next to the code stays unread.
  app.get("/api/source", async (req, res) => {
    const filePath = queryString(req.query.path);
    if (!filePath) {
      sendJson(res, 400, { error: "path is required." });
      return;
    }
    try {
      if (!(await isReadablePath(snapshot.repo.repoRoot, filePath))) {
        sendJson(res, 404, { error: "That file is not in this repository." });
        return;
      }
      const file = await readWorktreeTextFile(snapshot.repo.repoRoot, filePath);
      if (!file) {
        sendJson(res, 404, { error: "No text to show for that file." });
        return;
      }
      const payload: SourceFilePayload = {
        path: filePath,
        lines: file.lines,
        truncated: file.truncated,
      };
      sendJson(res, 200, payload);
    } catch (error) {
      const message = error instanceof GitError ? error.message : "Could not read that file.";
      sendJson(res, 400, { error: message });
    }
  });

  app.put("/api/diff", async (req, res) => {
    const parsed = readJsonBody(req);
    if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") {
      sendJson(res, 400, { error: "Request body must be JSON." });
      return;
    }
    const body = parsed.value as { scope?: string };
    const scope = body.scope;
    if (!scope || !isDiffScopeId(scope)) {
      sendJson(res, 400, { error: "Unknown diff scope." });
      return;
    }
    try {
      const next = await rebuildLocalReview(snapshot.repo, scope);
      if (next.selectedScope !== scope) {
        sendJson(res, 400, { error: "That diff is no longer available." });
        return;
      }
      if (next.empty) {
        sendJson(res, 400, { error: "That scope has no changes." });
        return;
      }
      snapshot = next;
      const published = publicSettings(settings, codingAgent);
      diffLog.info(`${scope}  ${next.diff.files.length} file(s)`);
      onStatus?.({
        ...sessionStatus(next, published),
        lastPullAt: new Date(),
        diffFresh: "up to date",
      });
      sendJson(res, 200, sessionPayload(next, published));
    } catch (error) {
      const message = error instanceof GitError ? error.message : "Could not load that diff.";
      sendJson(res, 400, { error: message });
    }
  });

  app.get("/api/github", async (_req, res) => {
    try {
      sendJson(res, 200, await githubStatus());
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not reach GitHub.";
      githubLog.warn(message);
      sendJson(res, 200, {
        enabled: githubEnabled,
        available: false,
        pullRequest: null,
        login: null,
        reason: message,
        warning: null,
      } satisfies GitHubStatusPayload);
    }
  });

  app.post("/api/github/review", async (req, res) => {
    const parsed = readJsonBody(req);
    if (!parsed.ok) {
      sendJson(res, 400, { ok: false, error: "Request body must be JSON." });
      return;
    }
    const body = parseSubmitReviewBody(parsed.value);
    if (!body) {
      sendJson(res, 400, {
        ok: false,
        code: "validation",
        error: "Provide a review body, an event, and comments.",
      });
      return;
    }

    const status = await githubStatus();
    if (!status.available || !status.pullRequest) {
      sendJson(res, 200, {
        ok: false,
        code: "not_authenticated",
        error: status.reason ?? "GitHub submission is unavailable.",
      });
      return;
    }

    const credentials = await resolveGitHubToken(snapshot.repo.repoRoot);
    if (!credentials) {
      sendJson(res, 200, {
        ok: false,
        code: "not_authenticated",
        error: `No GitHub credentials. ${GH_RECONNECT_HINT}`,
      });
      return;
    }

    const pr = status.pullRequest;
    const result = await submitPullRequestReview({
      accessToken: credentials.token,
      pr: { owner: pr.owner, repo: pr.repo, number: pr.number },
      body: body.body,
      event: body.event,
      comments: body.comments,
      reconnectHint: GH_RECONNECT_HINT,
    });
    if (result.ok) {
      githubLog.info(`submitted ${body.event} to ${pr.owner}/${pr.repo}#${pr.number}`);
    } else {
      githubLog.warn(`submit failed  ${result.error}`);
    }
    sendJson(res, 200, result);
  });

  app.get("/api/review-state", async (req, res) => {
    const key = queryString(req.query.key);
    if (!key) {
      sendJson(res, 400, { error: "key is required." });
      return;
    }
    try {
      sendJson(res, 200, { state: await readReviewSession(snapshot.repo.gitDir, key) });
    } catch (error) {
      stateLog.warn(error instanceof Error ? error.message : String(error));
      sendJson(res, 200, { state: null });
    }
  });

  const saveReviewState = async (req: Request, res: Response): Promise<void> => {
    const parsed = readJsonBody(req);
    if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") {
      sendJson(res, 400, { error: "Request body must be JSON." });
      return;
    }
    const { key, state } = parsed.value as { key?: unknown; state?: unknown };
    if (typeof key !== "string" || !key || key.length > 200) {
      sendJson(res, 400, { error: "key is required." });
      return;
    }
    // Reject rather than storing an empty review: a caller that omits `state`
    // is broken, and silently persisting null would look like a working save.
    if (state === undefined) {
      sendJson(res, 400, { error: "state is required." });
      return;
    }
    try {
      await writeReviewSession(snapshot.repo.gitDir, key, state);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not save the review.";
      stateLog.warn(message);
      sendJson(res, 500, { error: message });
    }
  };

  app.delete("/api/review-state", async (req, res) => {
    const key = queryString(req.query.key);
    if (!key) {
      sendJson(res, 400, { error: "key is required." });
      return;
    }
    try {
      await deleteReviewSession(snapshot.repo.gitDir, key);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not discard the review.";
      stateLog.warn(message);
      sendJson(res, 500, { error: message });
    }
  });

  app.put("/api/review-state", saveReviewState);
  // Same handler under POST: the unload-time flush cannot use PUT everywhere.
  app.post("/api/review-state", saveReviewState);

  app.get("/api/plan", async (req, res) => {
    res.status(200);
    res.set({
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.flushHeaders();
    res.socket?.setNoDelay(true);
    // Comment frame so EventSource leaves CONNECTING before the first provider call.
    res.write(":\n\n");
    const abort = new AbortController();
    let planFinished = false;
    req.on("close", () => {
      abort.abort();
      if (!planFinished) planLog.warn("client closed");
    });

    if (!canGenerateReview(settings, codingAgent)) {
      planLog.warn("no API key");
      res.write(
        `data: ${JSON.stringify({
          type: "ERROR",
          error: { message: "No API key configured.", code: "no_api_key" },
        })}\n\n`,
      );
      planFinished = true;
      res.end();
      return;
    }

    planLog.info(
      `${settings.provider}/${settings.model}  ${snapshot.selectedScope}  ${snapshot.diff.files.length} file(s)`,
    );

    for await (const event of annotateReview({
      diff: snapshot.diff,
      context: snapshot.context,
      settings,
      client: reviewClientFor(settings, codingAgent),
      signal: abort.signal,
    })) {
      if (abort.signal.aborted) return;
      const line = describePlanEvent(event);
      if (line) {
        if (event.type === "ERROR") planLog.error(line);
        else planLog.info(line);
      }
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    planFinished = true;
    res.end();
  });

  app.use(express.static(staticDir, { index: false, fallthrough: true }));

  app.use((req, res) => {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "Method not allowed." });
      return;
    }
    // Pass `root` so `send` only checks the relative path for dotfiles.
    // Absolute sendFile paths fail under install prefixes like ~/.nvm or ~/.npm.
    res.sendFile("index.html", { root: staticDir }, (err) => {
      if (!err) return;
      const missing = !existsSync(path.join(staticDir, "index.html"));
      const message = missing
        ? "UI assets missing from this install. Reinstall @guided-review/cli."
        : "Failed to serve UI.";
      uiLog.warn(
        missing ? message : `${message} ${err instanceof Error ? err.message : String(err)}`,
      );
      if (!res.headersSent) {
        sendJson(res, missing ? 404 : 500, { error: message });
      } else {
        res.end();
      }
    });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof SyntaxError) {
      sendJson(res, 400, { error: "Request body must be JSON." });
      return;
    }
    logger.error(err instanceof Error ? err : String(err));
    const message = err instanceof Error ? err.message : "Server error.";
    if (!res.headersSent) sendJson(res, 500, { error: message });
    else res.end();
  });

  return createHttpServer(app);
}

export function listen(server: ReturnType<typeof createReviewServer>, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to bind 127.0.0.1."));
        return;
      }
      resolve(address.port);
    });
  });
}

/**
 * Idempotent Ctrl+C / SIGTERM handler. `server.close(cb)` adds a `close` listener
 * per call; while SSE plans hold connections open, repeated signals would trip
 * MaxListenersExceededWarning. First signal closes the server and drops sockets;
 * a second signal forces exit.
 */
export function createServerShutdown(
  server: ReturnType<typeof createReviewServer>,
  exit: (code: number) => void = (code) => process.exit(code),
): () => void {
  let shuttingDown = false;
  return () => {
    if (shuttingDown) {
      exit(1);
      return;
    }
    shuttingDown = true;
    server.close(() => exit(0));
    server.closeAllConnections();
  };
}
