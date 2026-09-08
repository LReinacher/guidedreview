import { describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "./claudeCode";
import { createMemoryIo } from "./io";

const home = "/home/test";

describe("claudeCodeAdapter", () => {
  it("detects nothing when the CLI and config are absent", async () => {
    expect(await claudeCodeAdapter.detect(createMemoryIo({ home }))).toBeNull();
  });

  it("routes reviews through the claude binary and carries no secret", async () => {
    const io = createMemoryIo({
      home,
      binaries: ["claude"],
      // A subscription login the Messages API would reject; we never read it.
      keychain: {
        "Claude Code-credentials": JSON.stringify({
          claudeAiOauth: { accessToken: "sk-ant-oat01-live", expiresAt: Date.now() + 60_000 },
        }),
      },
      files: {
        [`${home}/.claude/settings.json`]: JSON.stringify({ model: "claude-sonnet-4-6" }),
      },
    });

    const detected = await claudeCodeAdapter.detect(io);
    expect(detected?.auth).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      secret: "",
      kind: "cli",
      usableForReview: true,
    });
    expect(claudeCodeAdapter.reviewClient).toBeDefined();
  });

  it("is unusable when Claude Code is configured but claude is not on PATH", async () => {
    const io = createMemoryIo({
      home,
      files: { [`${home}/.claude/settings.json`]: JSON.stringify({ model: "opus" }) },
    });
    const auth = await claudeCodeAdapter.resolveAuth(io);
    expect(auth.usableForReview).toBe(false);
    expect(auth.reason).toMatch(/not on your PATH/i);
    expect(auth.model).toBe("opus");
  });
});
