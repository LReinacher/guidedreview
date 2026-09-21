import type { DiffHunk } from "@guided-review/ui/review/types";

/** Last file line number of a hunk (prefer new side). */
export function hunkEndLine(hunk: DiffHunk): number | undefined {
  if (hunk.newLines > 0) return hunk.newStart + hunk.newLines - 1;
  if (hunk.oldLines > 0) return hunk.oldStart + hunk.oldLines - 1;
  return undefined;
}

/**
 * True when the next hunk starts after the previous ends with at least one
 * omitted line on the new side (preferred) or old side.
 */
export function hasLineGapBetween(prev: DiffHunk, next: DiffHunk): boolean {
  if (prev.newLines > 0 && next.newLines > 0) {
    return next.newStart > prev.newStart + prev.newLines;
  }
  if (prev.oldLines > 0 && next.oldLines > 0) {
    return next.oldStart > prev.oldStart + prev.oldLines;
  }
  return false;
}

/**
 * A run of lines the patch omitted between two hunks. Carries both sides'
 * anchors so the expander can label revealed context with old *and* new line
 * numbers — a gap is unchanged text, so the two advance in lockstep.
 */
export interface HunkGap {
  kind: "gap";
  key: string;
  /** Last line of the hunk above, per side. */
  afterOldLine: number;
  afterNewLine: number;
  /** First line of the hunk below, per side. */
  beforeOldLine: number;
  beforeNewLine: number;
  /** How many lines are hidden. */
  size: number;
}

/**
 * The rest of the file below the last displayed hunk. Unlike a gap it has no
 * hunk under it to bound it, so how much is left — if anything — is only known
 * once the host has been asked how long the file is.
 */
export interface FileTail {
  kind: "tail";
  key: string;
  /** Last line of the hunk above, per side. */
  afterOldLine: number;
  afterNewLine: number;
}

export type HunkSequenceItem = { kind: "hunk"; hunk: DiffHunk } | HunkGap | FileTail;

export interface HunkGapOptions {
  /**
   * Also mark the runs of file before the first hunk and after the last, so a
   * diff can be extended past the patch's own context. Off for hosts that
   * cannot read file text — there is nothing they could reveal.
   */
  fileEdges?: boolean;
}

/** Last line of a hunk on one side; `start - 1` when the side is empty. */
function endOf(start: number, count: number): number {
  return count > 0 ? start + count - 1 : start - 1;
}

function gapBetween(prev: DiffHunk, next: DiffHunk): HunkGap | null {
  const afterOldLine = endOf(prev.oldStart, prev.oldLines);
  const afterNewLine = endOf(prev.newStart, prev.newLines);
  const size = next.newStart - afterNewLine - 1;
  if (size <= 0) return null;
  return {
    kind: "gap",
    key: `gap-${prev.id}-${next.id}`,
    afterOldLine,
    afterNewLine,
    beforeOldLine: next.oldStart,
    beforeNewLine: next.newStart,
    size,
  };
}

/**
 * The lines above the first hunk, as a gap anchored at line 0. Deletion-only
 * hunks have no new-side position to count back from, so they get none.
 */
function gapAboveFirst(first: DiffHunk): HunkGap | null {
  if (first.newLines <= 0 || first.newStart <= 1) return null;
  return {
    kind: "gap",
    key: `gap-top-${first.id}`,
    afterOldLine: 0,
    afterNewLine: 0,
    beforeOldLine: first.oldStart,
    beforeNewLine: first.newStart,
    size: first.newStart - 1,
  };
}

/**
 * Interleave displayed hunks with gap markers for rendering.
 * Only inserts a gap between consecutive items in the displayed list.
 */
export function withHunkGaps(
  hunks: DiffHunk[],
  { fileEdges = false }: HunkGapOptions = {},
): HunkSequenceItem[] {
  const out: HunkSequenceItem[] = [];
  for (let i = 0; i < hunks.length; i++) {
    const hunk = hunks[i];
    if (i > 0) {
      const prev = hunks[i - 1];
      if (hasLineGapBetween(prev, hunk)) {
        const gap = gapBetween(prev, hunk);
        if (gap) out.push(gap);
      }
    }
    out.push({ kind: "hunk", hunk });
  }

  const first = hunks[0];
  const last = hunks[hunks.length - 1];
  if (!fileEdges || !first || !last) return out;

  const above = gapAboveFirst(first);
  if (above) out.unshift(above);
  if (last.newLines > 0) {
    out.push({
      kind: "tail",
      key: `gap-end-${last.id}`,
      afterOldLine: endOf(last.oldStart, last.oldLines),
      afterNewLine: endOf(last.newStart, last.newLines),
    });
  }
  return out;
}
