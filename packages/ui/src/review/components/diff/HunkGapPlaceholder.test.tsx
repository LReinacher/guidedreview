import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryReviewHost, setActiveReviewHost } from "@guided-review/ui/review/host";
import { useReviewStore } from "@guided-review/ui/review/store";
import type { HunkGap } from "@guided-review/ui/review/hunkGaps";
import { HunkGapPlaceholder } from "./HunkGapPlaceholder";

/** 50 hidden lines between line 10 (above) and line 61 (below). */
const GAP: HunkGap = {
  kind: "gap",
  key: "gap-a-b",
  afterOldLine: 10,
  afterNewLine: 10,
  beforeOldLine: 61,
  beforeNewLine: 61,
  size: 50,
};

const context = {
  title: "feat",
  description: "",
  baseRef: "main",
  headRef: "feat",
};

/** The file's real content: line N reads `line N`. */
function fileLines({ startLine, endLine }: { startLine: number; endLine: number }): string[] {
  const out: string[] = [];
  for (let n = startLine; n <= endLine; n++) out.push(`line ${n}`);
  return out;
}

function setHost(overrides = {}) {
  const host = createMemoryReviewHost({
    kind: "local",
    fileLines: vi.fn(async (request) => fileLines(request)),
    ...overrides,
  });
  setActiveReviewHost(host);
  return host;
}

beforeEach(() => {
  useReviewStore.setState({ prContext: context, diffViewMode: "unified" });
});

describe("HunkGapPlaceholder", () => {
  it("reveals a chunk from either end and asks the host for just that range", async () => {
    const host = setHost();
    render(<HunkGapPlaceholder filePath="src/foo.ts" gap={GAP} />);

    expect(screen.getByTestId("hunk-gap-placeholder")).toHaveTextContent("50 hidden lines");

    fireEvent.click(screen.getByTestId("hunk-gap-expand-down"));
    // Revealed code is syntax-highlighted into spans, so read the whole gap.
    const gap = () => screen.getByTestId("hunk-gap").textContent ?? "";
    await waitFor(() => expect(gap()).toContain("line 11"));
    expect(host.fileLines).toHaveBeenCalledWith(
      expect.objectContaining({ path: "src/foo.ts", side: "new", startLine: 11, endLine: 30 }),
    );
    expect(gap()).toContain("line 30");
    expect(gap()).not.toContain("line 31");

    fireEvent.click(screen.getByTestId("hunk-gap-expand-up"));
    await waitFor(() => expect(gap()).toContain("line 60"));
    expect(host.fileLines).toHaveBeenLastCalledWith(
      expect.objectContaining({ startLine: 41, endLine: 60 }),
    );
    // 50 hidden − 20 from the top − 20 from the bottom; the last 10 fit in
    // one chunk, so the bar collapses to a single Expand action.
    expect(screen.getByTestId("hunk-gap-expand-all")).toHaveTextContent("Expand 10 Hidden Lines");
  });

  it("collapses to a single Expand action once the rest fits in one chunk", async () => {
    setHost();
    render(
      <HunkGapPlaceholder filePath="src/foo.ts" gap={{ ...GAP, size: 4, beforeNewLine: 15 }} />,
    );

    const expandAll = screen.getByTestId("hunk-gap-expand-all");
    expect(expandAll).toHaveTextContent("Expand 4 Hidden Lines");

    fireEvent.click(expandAll);
    await waitFor(() => expect(screen.getByTestId("hunk-gap").textContent).toContain("line 14"));
    // Nothing left to reveal, so the bar goes away entirely.
    expect(screen.queryByTestId("hunk-gap-placeholder")).not.toBeInTheDocument();
  });

  it("falls back to a link when the host cannot read file text", async () => {
    setHost({
      fileLines: undefined,
      fileLineUrl: async () => "https://github.com/acme/widgets/blob/feat/src/foo.ts#L10",
    });
    render(<HunkGapPlaceholder filePath="src/foo.ts" gap={GAP} />);

    const link = await screen.findByRole("link", { name: /View Collapsed Lines/i });
    expect(link).toHaveAttribute("href", expect.stringContaining("#L10"));
  });

  it("surfaces a read failure without losing what is already expanded", async () => {
    setHost({ fileLines: async () => null });
    render(<HunkGapPlaceholder filePath="src/foo.ts" gap={GAP} />);

    fireEvent.click(screen.getByTestId("hunk-gap-expand-down"));
    await waitFor(() => expect(screen.getByTestId("hunk-gap-error")).toBeInTheDocument());
    expect(screen.getByTestId("hunk-gap-placeholder")).toHaveTextContent("50 hidden lines");
  });
});
