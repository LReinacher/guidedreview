import { describe, expect, it } from "vitest";
import { createMemoryIo } from "./io";
import {
  agentRunsLocally,
  canGenerateReview,
  detectAll,
  formatUnusable,
  parseCodingAgentFlag,
  pickAgent,
  settingsFromAuth,
} from "./registry";
import type { DetectedAgent } from "./types";

const home = "/home/test";

function agent(
  id: DetectedAgent["id"],
  usable: boolean,
  extras?: Partial<DetectedAgent["auth"]>,
): DetectedAgent {
  return {
    id,
    displayName: id,
    provider: id === "claude-code" ? "anthropic" : id === "codex" ? "openai" : "grok",
    auth: {
      provider: id === "claude-code" ? "anthropic" : id === "codex" ? "openai" : "grok",
      secret: usable ? "secret" : "",
      kind: "api_key",
      usableForReview: usable,
      reason: usable ? undefined : `${id} has no key`,
      ...extras,
    },
  };
}

describe("detectAll", () => {
  it("returns no agents on an empty machine", async () => {
    expect(await detectAll(createMemoryIo({ home }))).toEqual([]);
  });

  it("detects every agent that is present", async () => {
    const io = createMemoryIo({
      home,
      binaries: ["claude", "codex", "grok"],
      env: { ANTHROPIC_API_KEY: "sk-ant-api03-x", OPENAI_API_KEY: "sk-x", XAI_API_KEY: "xai-x" },
    });
    const found = await detectAll(io);
    expect(found.map((a) => a.id)).toEqual(["claude-code", "codex", "grok"]);
    expect(found.every((a) => a.auth.usableForReview)).toBe(true);
  });
});

describe("pickAgent", () => {
  it("still prompts when a saved preference exists among several agents", async () => {
    const chosen = await pickAgent({
      detected: [agent("claude-code", true), agent("grok", true)],
      preferred: "grok",
      isTTY: true,
      prompt: async (agents) => {
        expect(agents.map((a) => a.id)).toEqual(["claude-code", "grok"]);
        return "claude-code";
      },
    });
    expect(chosen?.id).toBe("claude-code");
  });

  it("returns the only usable agent without prompting", async () => {
    const chosen = await pickAgent({
      detected: [agent("claude-code", true), agent("codex", false)],
      isTTY: true,
      prompt: async () => {
        throw new Error("should not prompt");
      },
    });
    expect(chosen?.id).toBe("claude-code");
  });

  it("prompts when several agents are usable", async () => {
    const chosen = await pickAgent({
      detected: [agent("claude-code", true), agent("grok", true)],
      isTTY: true,
      prompt: async (agents) => {
        expect(agents.map((a) => a.id)).toEqual(["claude-code", "grok"]);
        return "grok";
      },
    });
    expect(chosen?.id).toBe("grok");
  });

  it("does not hang when several agents are usable off a TTY", async () => {
    const logs: string[] = [];
    const chosen = await pickAgent({
      detected: [agent("claude-code", true), agent("grok", true)],
      isTTY: false,
      log: (message) => logs.push(message),
      prompt: async () => {
        throw new Error("should not prompt");
      },
    });
    expect(chosen).toBeNull();
    expect(logs.join("\n")).toMatch(/--agent/);
  });

  it("honors --agent and errors when that agent is missing", async () => {
    await expect(
      pickAgent({ detected: [agent("grok", true)], requested: "codex" }),
    ).rejects.toThrow(/Codex is not installed/);
  });

  it("explains when agents are present but none are usable", async () => {
    const logs: string[] = [];
    const chosen = await pickAgent({
      detected: [agent("codex", false)],
      log: (message) => logs.push(message),
    });
    expect(chosen).toBeNull();
    expect(logs.join("\n")).toMatch(/none have a key/);
  });
});

describe("parseCodingAgentFlag / settingsFromAuth", () => {
  it("rejects an unknown --agent", () => {
    expect(() => parseCodingAgentFlag("cursor")).toThrow(/Unknown --agent/);
    expect(parseCodingAgentFlag(undefined)).toBeUndefined();
    expect(parseCodingAgentFlag("claude-code")).toBe("claude-code");
  });

  it("copies adapter auth onto ProviderSettings", () => {
    const settings = settingsFromAuth({
      provider: "grok",
      model: "grok-4.6",
      secret: "session-jwt",
      kind: "oauth",
      usableForReview: true,
      authScheme: "bearer",
    });
    expect(settings).toMatchObject({
      provider: "grok",
      model: "grok-4.6",
      apiKey: "session-jwt",
      authScheme: "bearer",
    });
  });

  it("reports which agents generate reviews by running locally", () => {
    expect(agentRunsLocally("claude-code")).toBe(true);
    expect(agentRunsLocally("grok")).toBe(false);
    expect(agentRunsLocally(null)).toBe(false);
  });

  it("needs no API key when the agent runs locally", () => {
    const settings = { provider: "anthropic" as const, model: "claude-opus-4-8", apiKey: "" };
    expect(canGenerateReview(settings, "claude-code")).toBe(true);
    expect(canGenerateReview(settings, "grok")).toBe(false);
    expect(canGenerateReview({ ...settings, apiKey: "sk" }, null)).toBe(true);
  });

  it("keeps an agent model that is not in the catalog", () => {
    const settings = settingsFromAuth({
      provider: "grok",
      model: "grok-build",
      secret: "xai-x",
      kind: "api_key",
      usableForReview: true,
    });
    expect(settings.model).toBe("grok-build");
  });

  it("lists unusable agents", () => {
    expect(formatUnusable([agent("codex", false)])).toMatch(/Found codex/);
  });
});
