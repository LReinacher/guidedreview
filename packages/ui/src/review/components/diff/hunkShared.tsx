/**
 * Shared hunk rendering: styles, syntax highlight, and per-line draft extras.
 * Used by UnifiedHunk and SplitHunk.
 */

import { cn, confirm } from "@guided-review/ui";
import { highlightToLines } from "@guided-review/ui/review/highlight";
import type { DiffHunk } from "@guided-review/ui/review/types";
import type { DraftComment } from "@guided-review/ui/review/commentTypes";
import { useReviewStore } from "@guided-review/ui/review/store";
import { CommentComposer } from "@guided-review/ui/review/components/CommentComposer";
import { DraftCommentCard } from "@guided-review/ui/review/components/DraftCommentCard";

/** File + line span the comment composer is currently anchored to. */
export type ComposerRange = {
  filePath: string;
  startLine: number;
  endLine: number;
} | null;

/** Shared per-hunk render props for `UnifiedHunk` and `SplitHunk`. */
export interface HunkViewProps {
  hunk: DiffHunk;
  language: string | undefined;
  selectedIds: Set<string>;
  focusId: string | null;
  draftsByEndLineId: Map<string, DraftComment[]>;
  composerPlacementId: string | null;
  composerRange: ComposerRange;
  unitId?: string;
}

/** Soft-wrap long lines (e.g. SVG paths) like GitHub — no horizontal scroll bleed. */
export const DIFF_LINE_WRAP = "flex min-w-0 whitespace-pre-wrap break-all pr-3";

/**
 * Hover/focus affordance for commenting on one line, in the gutter ahead of
 * the line numbers. Rendered for every commentable row, so it is kept cheap:
 * visibility is CSS-only (`group-hover`), with no per-row state.
 *
 * Shift-click extends the current selection, matching the keyboard's
 * Shift+Arrow. Rows without a selectable id (split-view padding, image rows)
 * pass `lineId === undefined` and get an inert spacer so columns still align.
 */
export function CommentLineButton({ lineId }: { lineId: string | undefined }) {
  const startCommentAtLine = useReviewStore((s) => s.startCommentAtLine);

  if (!lineId) return <span className="w-5 shrink-0" aria-hidden="true" />;

  return (
    <span className="relative w-5 shrink-0 select-none">
      <button
        type="button"
        // Stays in the DOM (not `hidden`) so keyboard focus can reach it.
        className={cn(
          "absolute inset-y-0 left-0 flex w-5 items-center justify-center opacity-0",
          "cursor-pointer rounded-sm bg-primary text-primary-foreground",
          "group-hover/line:opacity-100 focus-visible:opacity-100",
        )}
        aria-label="Comment on this line"
        title="Comment on this line (shift-click to extend)"
        data-testid="comment-line-button"
        onClick={(event) => {
          event.stopPropagation();
          startCommentAtLine(lineId, event.shiftKey);
        }}
      >
        <span aria-hidden="true" className="text-xs leading-none">
          +
        </span>
      </button>
    </span>
  );
}

export function selectionClasses(
  lineId: string | undefined,
  selectedIds: Set<string>,
  focusId: string | null,
): string {
  if (!lineId) return "";
  // Focus keeps the row wash; brand line-number gutter is layered on top.
  if (focusId === lineId) {
    return "bg-primary-muted";
  }
  if (selectedIds.has(lineId)) {
    return "bg-primary-muted/70";
  }
  return "";
}

/**
 * Brand highlight on gutter numbers for the focused line and every line in the
 * current multi-line selection.
 */
export function lineNumberClasses(isHighlighted: boolean): string {
  return cn(
    "w-10 shrink-0 select-none pr-3 text-right",
    isHighlighted ? "bg-primary font-medium text-primary-foreground" : "text-faint",
  );
}

/**
 * Highlight a hunk's lines against GitHub's syntax palette.
 *
 * Reconstructs old (context + del) and new (context + add) text, highlights each
 * as a whole so multi-line constructs tokenize correctly, then maps fragments
 * back onto hunk lines.
 */
export function highlightHunkLines(
  hunk: DiffHunk,
  language: string | undefined,
): (string | null)[] {
  if (!language) return hunk.lines.map(() => null);

  const oldText = hunk.lines
    .filter((l) => l.type !== "add")
    .map((l) => l.content)
    .join("\n");
  const newText = hunk.lines
    .filter((l) => l.type !== "del")
    .map((l) => l.content)
    .join("\n");

  const oldHighlighted = highlightToLines(oldText, language);
  const newHighlighted = highlightToLines(newText, language);

  let oldCursor = 0;
  let newCursor = 0;
  return hunk.lines.map((line) => {
    if (line.type === "del") return oldHighlighted[oldCursor++] ?? null;
    if (line.type === "add") return newHighlighted[newCursor++] ?? null;
    const fragment = newHighlighted[newCursor] ?? oldHighlighted[oldCursor] ?? null;
    oldCursor++;
    newCursor++;
    return fragment;
  });
}

/**
 * One line of code text. `data-code-text` is the hook command-click uses to
 * find the line's text under the pointer — every rendered code line must carry
 * it, or go-to-definition silently stops working on that row.
 */
export function CodeContent({
  content,
  highlighted,
}: {
  content: string;
  highlighted: string | null;
}) {
  if (highlighted != null) {
    return <span data-code-text="" dangerouslySetInnerHTML={{ __html: highlighted }} />;
  }
  return <span data-code-text="">{content}</span>;
}

interface LineExtrasProps {
  lineId: string;
  draftsByEndLineId: Map<string, DraftComment[]>;
  composerPlacementId: string | null;
  composerRange: ComposerRange;
  unitId?: string;
}

export function LineExtras({
  lineId,
  draftsByEndLineId,
  composerPlacementId,
  composerRange,
  unitId,
}: LineExtrasProps) {
  const saveDraftComment = useReviewStore((s) => s.saveDraftComment);
  const setDraftCommentTarget = useReviewStore((s) => s.setDraftCommentTarget);
  const closeComposer = useReviewStore((s) => s.closeComposer);
  const removeDraftComment = useReviewStore((s) => s.removeDraftComment);
  const updateDraftComment = useReviewStore((s) => s.updateDraftComment);
  const drafts = draftsByEndLineId.get(lineId) ?? [];
  const showComposer = composerPlacementId === lineId && composerRange;

  if (!showComposer && drafts.length === 0) return null;

  function requestRemoveDraft(id: string): void {
    confirm({
      title: "Remove Comment?",
      body: "This comment will be removed. You can comment on these lines again later.",
      variant: "destructive",
      okButtonText: "Remove",
      cancelButtonText: "Cancel",
      okButtonHandler: () => {
        removeDraftComment(id);
      },
    });
  }

  return (
    <div className="font-sans" data-testid={`line-extras-${lineId}`}>
      {drafts.map((d) => (
        <DraftCommentCard
          key={d.id}
          comment={d}
          onRemove={requestRemoveDraft}
          onUpdate={updateDraftComment}
          onTargetChange={setDraftCommentTarget}
        />
      ))}
      {showComposer && (
        <CommentComposer
          filePath={composerRange.filePath}
          startLine={composerRange.startLine}
          endLine={composerRange.endLine}
          onSave={(body, target) => saveDraftComment(body, unitId, target)}
          onCancel={closeComposer}
        />
      )}
    </div>
  );
}
