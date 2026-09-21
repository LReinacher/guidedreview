import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  buildUserPrompt,
  ProviderError,
  REVIEW_EFFORT,
  REVIEW_PLAN_JSON_SCHEMA,
  SYSTEM_PROMPT,
  type AnnotateStreamEvent,
  type ProviderAnnotateInput,
  type ProviderClient,
  type ProviderSettings,
} from "@guided-review/core";

export const CLAUDE_COMMAND = "claude";

const NOT_INSTALLED =
  "Could not run `claude`. Install Claude Code and make sure `claude` is on your PATH, or set ANTHROPIC_API_KEY.";

/** Tail of the child's stderr we keep for error messages. */
const STDERR_LIMIT = 4000;

/**
 * Flags shared by every `claude -p` call.
 *
 * A Claude subscription login is an OAuth session the Messages API rejects, so
 * we never hold that credential ourselves — we shell out to Claude Code and let
 * it authenticate. `--safe-mode` keeps the run reproducible: no CLAUDE.md,
 * hooks, plugins, MCP servers, or custom agents from whatever repo the user
 * happens to be in. Auth and model selection still work normally under it.
 *
 * Unlike the Messages API, Claude Code drops `--effort` for models without the
 * knob rather than erroring, so it is safe to pass for every model.
 */
function baseArgs(model: string): string[] {
  return [
    "--print",
    "--model",
    model,
    "--effort",
    REVIEW_EFFORT,
    "--safe-mode",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--disable-slash-commands",
    // We only want text generation; the plan must come from the diff we send.
    "--tools",
    "",
  ];
}

function reviewArgs(model: string): string[] {
  return [
    ...baseArgs(model),
    "--verbose", // required by --output-format=stream-json
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--system-prompt",
    SYSTEM_PROMPT,
    "--json-schema",
    JSON.stringify(REVIEW_PLAN_JSON_SCHEMA),
  ];
}

/**
 * Runs `claude` with the prompt on stdin and yields stdout NDJSON lines.
 * Throws a ProviderError if the process cannot start or exits non-zero.
 */
export type ClaudeLineStream = (
  args: string[],
  prompt: string,
  signal?: AbortSignal,
) => AsyncGenerator<string, void, unknown>;

function exitError(code: number | null, stderr: string): ProviderError {
  const detail = stderr.trim().split("\n").filter(Boolean).at(-1);
  return new ProviderError(
    detail ? `Claude Code failed: ${detail}` : `Claude Code exited with code ${code ?? "unknown"}.`,
    { code: "claude_cli_failed" },
  );
}

async function* spawnClaudeLines(
  args: string[],
  prompt: string,
  signal?: AbortSignal,
): AsyncGenerator<string, void, unknown> {
  const child = spawn(CLAUDE_COMMAND, args, { stdio: ["pipe", "pipe", "pipe"] });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_LIMIT);
  });

  // `error` fires instead of `close` when the binary is missing or unrunnable.
  const failure: { error?: NodeJS.ErrnoException } = {};
  const exited = new Promise<number | null>((resolve) => {
    child.once("error", (error: NodeJS.ErrnoException) => {
      failure.error = error;
      resolve(null);
    });
    child.once("close", (code) => resolve(code));
  });

  const onAbort = () => child.kill("SIGTERM");
  signal?.addEventListener("abort", onAbort, { once: true });

  // Claude can exit before it drains a large diff; EPIPE here is not an error.
  child.stdin.on("error", () => {});
  child.stdin.end(prompt);

  try {
    for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      if (line.trim()) yield line;
    }
    const code = await exited;
    if (signal?.aborted) return;
    if (failure.error) {
      throw new ProviderError(
        failure.error.code === "ENOENT"
          ? NOT_INSTALLED
          : `Could not run \`claude\`: ${failure.error.message}`,
        { code: "claude_cli_unavailable" },
      );
    }
    if (code !== 0) throw exitError(code, stderr);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
}

// ---- stream-json shapes we care about --------------------------------------

interface StreamLine {
  type?: string;
  subtype?: string;
  event?: {
    type?: string;
    index?: number;
    content_block?: { type?: string; name?: string };
    delta?: { type?: string; partial_json?: string };
  };
  is_error?: boolean;
  result?: unknown;
  structured_output?: unknown;
}

function parseLine(line: string): StreamLine | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed && typeof parsed === "object" ? (parsed as StreamLine) : null;
  } catch {
    return null;
  }
}

function resultError(line: StreamLine): ProviderError {
  const message = typeof line.result === "string" && line.result.trim() ? line.result.trim() : null;
  return new ProviderError(message ?? "Claude Code could not finish this review.", {
    code: line.subtype,
  });
}

/**
 * `--json-schema` makes Claude answer through a `StructuredOutput` tool call,
 * so the plan arrives as `input_json_delta` fragments on that content block.
 * Those fragments are the same partial JSON the HTTP providers stream, which
 * lets `StreamPlanParser` surface units before the model is done.
 */
export function createClaudeCliProvider(
  runLines: ClaudeLineStream = spawnClaudeLines,
): ProviderClient {
  return {
    async *annotateReviewStream(
      { diff, context, settings }: ProviderAnnotateInput,
      options?: { signal?: AbortSignal },
    ): AsyncGenerator<AnnotateStreamEvent, void, unknown> {
      let structuredIndex: number | null = null;
      let sawPlanText = false;
      // Used only when the model answered without streaming the tool input.
      let finalPlan: string | null = null;

      for await (const raw of runLines(
        reviewArgs(settings.model),
        buildUserPrompt(diff, context),
        options?.signal,
      )) {
        const line = parseLine(raw);
        if (!line) continue;

        if (line.type === "result") {
          if (line.is_error || (line.subtype && line.subtype !== "success")) {
            throw resultError(line);
          }
          if (line.structured_output && typeof line.structured_output === "object") {
            finalPlan = JSON.stringify(line.structured_output);
          } else if (typeof line.result === "string") {
            finalPlan = line.result;
          }
          continue;
        }

        if (line.type !== "stream_event" || !line.event) continue;
        const event = line.event;

        if (event.type === "content_block_start") {
          if (event.content_block?.name === "StructuredOutput") {
            structuredIndex = event.index ?? null;
          }
          continue;
        }

        if (event.type !== "content_block_delta") {
          // message_start means the request landed — surface life in the UI.
          if (event.type === "message_start") yield { type: "heartbeat" };
          continue;
        }

        if (event.delta?.type === "thinking_delta") {
          yield { type: "heartbeat" };
          continue;
        }

        if (
          event.delta?.type === "input_json_delta" &&
          event.index === structuredIndex &&
          event.delta.partial_json
        ) {
          sawPlanText = true;
          yield { type: "text_delta", text: event.delta.partial_json };
        }
      }

      if (options?.signal?.aborted) return;

      if (!sawPlanText) {
        if (!finalPlan) {
          throw new ProviderError("Claude Code returned no review plan for this diff.");
        }
        yield { type: "text_delta", text: finalPlan };
      }

      yield { type: "done" };
    },

    async testConnection(settings: ProviderSettings): Promise<void> {
      const args = [...baseArgs(settings.model), "--output-format", "json"];
      let sawResult = false;

      for await (const raw of runLines(args, "Reply with OK.")) {
        const line = parseLine(raw);
        if (!line || line.type !== "result") continue;
        sawResult = true;
        if (line.is_error || (line.subtype && line.subtype !== "success")) {
          throw resultError(line);
        }
      }

      if (!sawResult) throw new ProviderError("Claude Code did not answer.");
    },
  };
}

/** Routes Claude reviews through the locally installed `claude` binary. */
export const claudeCliProvider = createClaudeCliProvider();
