import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { DiffHunk, ResolvedUnitFile } from "@guided-review/core";
import { createMemoryReviewHost, setActiveReviewHost } from "@guided-review/ui/review/host";
import { useReviewStore } from "@guided-review/ui/review/store";
import { DiffPane } from "@guided-review/ui/review/components/DiffPane";

/** The reviewed file has 100 lines; the only hunk touches 41-43. */
const TOTAL_LINES = 100;

const HUNK: DiffHunk = {
  id: "src/foo.ts#0",
  header: "@@ -41,2 +41,3 @@",
  oldStart: 41,
  oldLines: 2,
  newStart: 41,
  newLines: 3,
  lines: [
    { type: "context", content: "const a = 1;", oldLine: 41, newLine: 41 },
    { type: "add", content: "const b = 2;", newLine: 42 },
    { type: "context", content: "const c = 3;", oldLine: 42, newLine: 43 },
  ],
};

function files(): ResolvedUnitFile[] {
  return [
    {
      file: { path: "src/foo.ts", status: "modified", isBinaryOrElided: false, hunks: [HUNK] },
      hunks: [HUNK],
    },
  ];
}

/** The file's real content: line N reads `line N`. */
function hostFileLines({ startLine, endLine }: { startLine: number; endLine: number }): string[] {
  const out: string[] = [];
  for (let n = startLine; n <= Math.min(endLine, TOTAL_LINES); n++) out.push(`line ${n}`);
  return out;
}

beforeEach(() => {
  setActiveReviewHost(
    createMemoryReviewHost({
      kind: "local",
      fileLines: async (request) => hostFileLines(request),
      fileLineCount: async () => TOTAL_LINES,
    }),
  );
  useReviewStore.setState({
    prContext: { title: "feat", description: "", baseRef: "main", headRef: "feat" },
    diffViewMode: "unified",
    uiMode: "navigate",
    draftComments: [],
  });
});

describe("extending a diff past its hunks", () => {
  it("expands above the first hunk and below the last, then collapses again", async () => {
    render(<DiffPane files={files()} unitTitle="Update foo" selectableForUnit={[]} />);

    // 40 lines above the hunk, 57 below it — the tail count comes from the host.
    await waitFor(() => expect(screen.getAllByTestId("hunk-gap-placeholder")).toHaveLength(2));
    const above = () => within(screen.getAllByTestId("hunk-gap")[0]);
    const below = () => within(screen.getAllByTestId("hunk-gap")[1]);
    expect(above().getByTestId("hunk-gap-placeholder")).toHaveTextContent("40 hidden lines");
    expect(below().getByTestId("hunk-gap-placeholder")).toHaveTextContent("57 hidden lines");
    expect(screen.queryByTestId("collapse-expanded-button")).not.toBeInTheDocument();

    // Reveal the 20 lines directly above the hunk, and the 20 directly below.
    const diff = () => screen.getByTestId("diff-file-header").parentElement?.textContent ?? "";
    await act(async () => {
      fireEvent.click(above().getByTestId("hunk-gap-expand-up"));
    });
    await waitFor(() => expect(diff()).toContain("line 40"));

    await act(async () => {
      fireEvent.click(below().getByTestId("hunk-gap-expand-down"));
    });
    await waitFor(() => expect(diff()).toContain("line 44"));
    expect(diff()).toContain("line 63");
    expect(diff()).not.toContain("line 64");

    await act(async () => {
      fireEvent.click(screen.getByTestId("collapse-expanded-button"));
    });
    expect(diff()).not.toContain("line 40");
    expect(diff()).not.toContain("line 44");
    await waitFor(() =>
      expect(screen.queryByTestId("collapse-expanded-button")).not.toBeInTheDocument(),
    );
  });

  it("leaves the file edges alone when the host cannot read file text", async () => {
    setActiveReviewHost(createMemoryReviewHost({ kind: "github" }));
    render(<DiffPane files={files()} unitTitle="Update foo" selectableForUnit={[]} />);

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId("hunk-gap-placeholder")).not.toBeInTheDocument();
  });
});
