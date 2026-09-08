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

export type HunkSequenceItem = { kind: "hunk"; hunk: DiffHunk } | HunkGap;

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
 * Interleave displayed hunks with gap markers for rendering.
 * Only inserts a gap between consecutive items in the displayed list.
 */
export function withHunkGaps(hunks: DiffHunk[]): HunkSequenceItem[] {
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
  return out;
}
