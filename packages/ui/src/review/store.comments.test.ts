import { beforeEach, describe, expect, it } from "vitest";
import { useReviewStore } from "./store";
import { githubComments, isLineComment, lineIdFor, type SelectableLine } from "./commentTypes";

function line(index: number): SelectableLine {
  return {
    id: lineIdFor("src/foo.ts#0", index, "RIGHT"),
    filePath: "src/foo.ts",
    hunkId: "src/foo.ts#0",
    lineIndex: index,
    side: "RIGHT",
    newLine: index + 1,
    type: "context",
    content: `line ${index + 1}`,
  };
}

const LINES = [line(0), line(1), line(2)];

beforeEach(() => {
  useReviewStore.setState({
    uiMode: "navigate",
    lineSelection: null,
    composerOpen: false,
    fileComposerPath: null,
    draftComments: [],
  });
  useReviewStore.getState().setSelectableLines(LINES);
});

describe("clicking a line to comment", () => {
  it("enters comment mode on that line with the composer already open", () => {
    useReviewStore.getState().startCommentAtLine(LINES[1].id);

    const state = useReviewStore.getState();
    expect(state.uiMode).toBe("comment");
    expect(state.composerOpen).toBe(true);
    expect(state.lineSelection).toEqual({ anchorIndex: 1, focusIndex: 1 });

    state.saveDraftComment("needs a test");
    const [draft] = useReviewStore.getState().draftComments;
    expect(draft.scope).toBe("line");
    expect(isLineComment(draft) && draft.startLine).toBe(2);
    expect(isLineComment(draft) && draft.endLine).toBe(2);
  });

  it("extends the existing selection on shift-click", () => {
    useReviewStore.getState().startCommentAtLine(LINES[0].id);
    useReviewStore.getState().startCommentAtLine(LINES[2].id, true);

    expect(useReviewStore.getState().lineSelection).toEqual({ anchorIndex: 0, focusIndex: 2 });

    useReviewStore.getState().saveDraftComment("spans three lines");
    const [draft] = useReviewStore.getState().draftComments;
    expect(isLineComment(draft) && draft.startLine).toBe(1);
    expect(isLineComment(draft) && draft.endLine).toBe(3);
  });

  it("ignores a line that is not in the current unit", () => {
    useReviewStore.getState().startCommentAtLine("src/other.ts#0:0:RIGHT");
    expect(useReviewStore.getState().uiMode).toBe("navigate");
  });
});

describe("commenting on a whole file", () => {
  it("saves a draft with no line anchor", () => {
    useReviewStore.getState().openFileComposer("src/foo.ts");
    expect(useReviewStore.getState().fileComposerPath).toBe("src/foo.ts");

    useReviewStore.getState().saveFileComment("this module does too much", "unit-1");

    const [draft] = useReviewStore.getState().draftComments;
    expect(draft).toEqual({
      id: expect.any(String) as unknown as string,
      scope: "file",
      target: "github",
      filePath: "src/foo.ts",
      body: "this module does too much",
      unitId: "unit-1",
    });
    // Composer closes so the header button can open a fresh one.
    expect(useReviewStore.getState().fileComposerPath).toBeNull();
  });

  it("does not save an empty body or one with no open composer", () => {
    useReviewStore.getState().openFileComposer("src/foo.ts");
    useReviewStore.getState().saveFileComment("   ");
    useReviewStore.getState().closeFileComposer();
    useReviewStore.getState().saveFileComment("too late");

    expect(useReviewStore.getState().draftComments).toEqual([]);
  });
});

describe("comment destinations", () => {
  it("keeps local notes out of a GitHub submission and out of the way when it clears", () => {
    useReviewStore.getState().startCommentAtLine(LINES[0].id);
    useReviewStore.getState().saveDraftComment("post this", "unit-1", "github");
    useReviewStore.getState().openFileComposer("src/foo.ts");
    useReviewStore.getState().saveFileComment("just for me", "unit-1", "local");

    const drafts = useReviewStore.getState().draftComments;
    expect(githubComments(drafts).map((d) => d.body)).toEqual(["post this"]);

    // Submitting posts the GitHub ones and consumes only those.
    useReviewStore.getState().clearDraftComments("github");
    expect(useReviewStore.getState().draftComments.map((d) => d.body)).toEqual(["just for me"]);
  });

  it("moves a saved comment between destinations", () => {
    useReviewStore.getState().startCommentAtLine(LINES[0].id);
    useReviewStore.getState().saveDraftComment("post this", "unit-1", "github");
    const [draft] = useReviewStore.getState().draftComments;

    useReviewStore.getState().setDraftCommentTarget(draft.id, "local");
    expect(githubComments(useReviewStore.getState().draftComments)).toEqual([]);
  });
});
