import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryReviewHost, setActiveReviewHost } from "./host";
import { persistSession, restoreSession, useReviewStore } from "./store";
import type { DraftComment } from "./commentTypes";

const SESSION_KEY = "repo:main:feat:branch";

function diffFixture() {
  return { files: [] };
}

function planFixture() {
  return {
    units: [{ id: "u1", title: "Unit", kind: "change" as const, context: "because", files: [] }],
  };
}

const drafts: DraftComment[] = [
  { id: "d1", scope: "file", target: "github", filePath: "a.ts", body: "post this" },
  { id: "d2", scope: "file", target: "local", filePath: "a.ts", body: "just for me" },
];

/** A review the user has commented on but not yet structured with AI. */
function seedUnstructuredReview(): void {
  useReviewStore.getState().bootReady({
    sessionKey: SESSION_KEY,
    diff: diffFixture(),
    plan: planFixture(),
    diffHash: "hash-1",
  });
  useReviewStore.setState({ draftComments: drafts, currentUnitIndex: 1 });
}

beforeEach(() => {
  useReviewStore.setState({
    status: "idle",
    diff: null,
    plan: null,
    draftComments: [],
    currentUnitIndex: 0,
    sessionKey: null,
    diffHash: null,
    planSource: null,
  });
});

describe("durable review sessions", () => {
  it("resumes an unstructured review with both kinds of comment when the host opts in", async () => {
    setActiveReviewHost(createMemoryReviewHost({ kind: "local", persistPartialSessions: true }));
    seedUnstructuredReview();

    await persistSession();
    useReviewStore.setState({ diff: null, plan: null, draftComments: [], currentUnitIndex: 0 });

    const restored = await restoreSession(SESSION_KEY);

    expect(restored).toEqual({ planSource: "files", diffHash: "hash-1", draftCount: 2 });
    const state = useReviewStore.getState();
    expect(state.status).toBe("ready");
    expect(state.plan).toEqual(planFixture());
    expect(state.currentUnitIndex).toBe(1);
    expect(state.draftComments).toEqual(drafts);
  });

  it("still skips cheap file plans for hosts that only cache AI structure", async () => {
    setActiveReviewHost(createMemoryReviewHost());
    seedUnstructuredReview();

    await persistSession();

    expect(await restoreSession(SESSION_KEY)).toBeNull();
  });
});
