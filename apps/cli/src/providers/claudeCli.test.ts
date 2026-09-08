import { describe, expect, it } from "vitest";
import type { ParsedDiff, ProviderSettings } from "@guided-review/core";
import { createClaudeCliProvider, type ClaudeLineStream } from "./claudeCli";

const settings: ProviderSettings = {
  provider: "anthropic",
  model: "claude-opus-4-8",
  apiKey: "",
};

const diff: ParsedDiff = {
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
};

const context = { title: "feat", description: "", baseRef: "main", headRef: "feat" };

function streamEvent(event: unknown): string {
  return JSON.stringify({ type: "stream_event", event });
}

/** stdout as Claude Code emits it for `--json-schema`: a StructuredOutput tool call. */
const PLAN_LINES = [
  JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-4-8" }),
  streamEvent({ type: "message_start" }),
  streamEvent({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }),
  streamEvent({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta" } }),
  streamEvent({
    type: "content_block_start",
    index: 1,
    content_block: { type: "tool_use", name: "StructuredOutput" },
  }),
  streamEvent({
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: '{"units": [' },
  }),
  streamEvent({
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: "]}" },
  }),
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result: '{"units":[]}' }),
];

function fakeRunner(lines: string[], captured?: { args: string[][]; prompts: string[] }) {
  const run: ClaudeLineStream = async function* (args, prompt) {
    captured?.args.push(args);
    captured?.prompts.push(prompt);
    for (const line of lines) yield line;
  };
  return run;
}

async function collect(lines: string[], captured?: { args: string[][]; prompts: string[] }) {
  const provider = createClaudeCliProvider(fakeRunner(lines, captured));
  const events = [];
  for await (const event of provider.annotateReviewStream({ diff, context, settings })) {
    events.push(event);
  }
  return events;
}

describe("claude CLI provider", () => {
  it("streams the structured plan as text deltas and reports life while thinking", async () => {
    const captured = { args: [] as string[][], prompts: [] as string[] };
    const events = await collect(PLAN_LINES, captured);

    expect(events).toEqual([
      { type: "heartbeat" },
      { type: "heartbeat" },
      { type: "text_delta", text: '{"units": [' },
      { type: "text_delta", text: "]}" },
      { type: "done" },
    ]);

    const args = captured.args[0]!;
    expect(args).toContain("--print");
    expect(args).toContain("--json-schema");
    expect(args).toContain("stream-json");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-opus-4-8");
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
    // The diff goes over stdin, not argv — it is far too big for an argument.
    expect(captured.prompts[0]).toContain("src/a.ts#0");
  });

  it("falls back to the final structured output when nothing streamed", async () => {
    const events = await collect([
      JSON.stringify({
        type: "result",
        subtype: "success",
        structured_output: { units: [] },
      }),
    ]);
    expect(events).toEqual([{ type: "text_delta", text: '{"units":[]}' }, { type: "done" }]);
  });

  it("surfaces a failed run as a provider error", async () => {
    await expect(
      collect([
        JSON.stringify({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          result: "Claude usage limit reached.",
        }),
      ]),
    ).rejects.toThrow("Claude usage limit reached.");
  });

  it("errors when the run produced no plan at all", async () => {
    await expect(collect([JSON.stringify({ type: "system", subtype: "init" })])).rejects.toThrow(
      /no review plan/i,
    );
  });
});
