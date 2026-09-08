import { useEffect, useState } from "react";
import { cn } from "@guided-review/ui";
import { useReviewHost } from "@guided-review/ui/review/host";
import { useReviewStore } from "@guided-review/ui/review/store";
import { highlightToLines, languageForPath } from "@guided-review/ui/review/highlight";
import type { HunkGap } from "@guided-review/ui/review/hunkGaps";
import { CodeContent, DIFF_LINE_WRAP, lineNumberClasses } from "./hunkShared";

/** Lines revealed per click, matching GitHub's expand step. */
const CHUNK = 20;

interface HunkGapPlaceholderProps {
  filePath: string;
  gap: HunkGap;
}

const BAR_CLASSES =
  // Match the surrounding hunk surface (parent is bg-surface-raised); no
  // separate wash so it reads as part of the diff, not a chrome bar.
  "flex w-full items-center justify-center gap-2 border-y border-border py-1.5 font-mono text-sm text-faint";

/**
 * One revealed context line. Not commentable: `buildSelectableLines` only
 * walks hunk lines, so these have no SelectableLine id — the leading spacer
 * keeps them column-aligned with the rows that do.
 */
function ContextRow({
  oldLine,
  newLine,
  content,
  highlighted,
  split,
}: {
  oldLine: number;
  newLine: number;
  content: string;
  highlighted: string | null;
  split: boolean;
}) {
  const code = (
    <span className="min-w-0 flex-1">
      <CodeContent content={content} highlighted={highlighted} />
    </span>
  );

  if (split) {
    return (
      <div className="flex min-w-0 border-b border-border-strong last:border-b-0">
        <div className={cn(DIFF_LINE_WRAP, "flex-1 overflow-hidden")}>
          <span className="w-5 shrink-0" aria-hidden="true" />
          <span className={lineNumberClasses(false)}>{oldLine}</span>
          <span className="w-4 shrink-0" aria-hidden="true" />
          {code}
        </div>
        <div className="w-px shrink-0 bg-border" aria-hidden="true" />
        <div className={cn(DIFF_LINE_WRAP, "flex-1 overflow-hidden")}>
          <span className="w-5 shrink-0" aria-hidden="true" />
          <span className={lineNumberClasses(false)}>{newLine}</span>
          <span className="w-4 shrink-0" aria-hidden="true" />
          {code}
        </div>
      </div>
    );
  }

  return (
    <div className={DIFF_LINE_WRAP}>
      <span className="w-5 shrink-0" aria-hidden="true" />
      <span className={lineNumberClasses(false)}>{oldLine}</span>
      <span className={lineNumberClasses(false)}>{newLine}</span>
      <span className="w-4 shrink-0" aria-hidden="true" />
      {code}
    </div>
  );
}

function ExpandButton({
  label,
  title,
  onClick,
  busy,
  testId,
}: {
  label: string;
  title: string;
  onClick: () => void;
  busy: boolean;
  testId: string;
}) {
  return (
    <button
      type="button"
      className={cn(
        "cursor-pointer rounded px-2 py-0.5 text-sm text-faint",
        "hover:bg-surface-muted hover:text-muted disabled:cursor-wait disabled:opacity-60",
      )}
      onClick={onClick}
      disabled={busy}
      title={title}
      aria-label={title}
      data-testid={testId}
    >
      {label}
    </button>
  );
}

/**
 * The omitted lines between two hunks.
 *
 * With a host that can read file text (`fileLines`) this expands in place, a
 * chunk at a time from either end, the way GitHub does. Hosts without it —
 * where there is no file to read, only a URL — keep the old behaviour of
 * linking out to the file at that line.
 */
export function HunkGapPlaceholder({ filePath, gap }: HunkGapPlaceholderProps) {
  const host = useReviewHost();
  const prContext = useReviewStore((s) => s.prContext);
  const split = useReviewStore((s) => s.diffViewMode) === "split";
  const [href, setHref] = useState<string | null>(null);
  const [top, setTop] = useState<string[]>([]);
  const [bottom, setBottom] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canExpand = Boolean(host.fileLines && prContext);
  const hidden = gap.size - top.length - bottom.length;
  const language = languageForPath(filePath);

  useEffect(() => {
    if (canExpand || !prContext || !host.fileLineUrl) {
      setHref(null);
      return;
    }
    let cancelled = false;
    void host.fileLineUrl(filePath, gap.afterNewLine, prContext).then((url) => {
      if (!cancelled) setHref(url);
    });
    return () => {
      cancelled = true;
    };
  }, [canExpand, host, prContext, filePath, gap.afterNewLine]);

  /** Fetch `[startLine, endLine]` and keep it at the requested end of the gap. */
  async function reveal(startLine: number, endLine: number, end: "top" | "bottom"): Promise<void> {
    if (!host.fileLines || !prContext || startLine > endLine) return;
    setBusy(true);
    setError(null);
    try {
      const lines = await host.fileLines({
        path: filePath,
        side: "new",
        startLine,
        endLine,
        context: prContext,
      });
      if (!lines || lines.length === 0) {
        setError("Could not read those lines.");
        return;
      }
      if (end === "top") setTop((prev) => [...prev, ...lines]);
      else setBottom((prev) => [...lines, ...prev]);
    } catch {
      setError("Could not read those lines.");
    } finally {
      setBusy(false);
    }
  }

  // Bounds of the still-hidden run, in new-file coordinates.
  const hiddenStart = gap.afterNewLine + 1 + top.length;
  const hiddenEnd = gap.beforeNewLine - 1 - bottom.length;

  // Highlight each revealed run as one block so multi-line constructs tokenize.
  const highlight = (lines: string[]): (string | null)[] =>
    language ? highlightToLines(lines.join("\n"), language) : lines.map(() => null);
  const topHighlighted = highlight(top);
  const bottomHighlighted = highlight(bottom);

  const rows = (
    <>
      {top.map((content, i) => (
        <ContextRow
          key={`top-${gap.afterNewLine + 1 + i}`}
          oldLine={gap.afterOldLine + 1 + i}
          newLine={gap.afterNewLine + 1 + i}
          content={content}
          highlighted={topHighlighted[i] ?? null}
          split={split}
        />
      ))}
    </>
  );

  const bottomRows = (
    <>
      {bottom.map((content, i) => (
        <ContextRow
          key={`bottom-${gap.beforeNewLine - bottom.length + i}`}
          oldLine={gap.beforeOldLine - bottom.length + i}
          newLine={gap.beforeNewLine - bottom.length + i}
          content={content}
          highlighted={bottomHighlighted[i] ?? null}
          split={split}
        />
      ))}
    </>
  );

  if (canExpand) {
    return (
      <div data-testid="hunk-gap">
        {rows}
        {hidden > 0 && (
          <div className={BAR_CLASSES} data-testid="hunk-gap-placeholder">
            {hidden <= CHUNK ? (
              <ExpandButton
                label={`⋯ Expand ${hidden} Hidden Line${hidden === 1 ? "" : "s"} ⋯`}
                title={`Expand the remaining ${hidden} hidden lines`}
                busy={busy}
                testId="hunk-gap-expand-all"
                onClick={() => void reveal(hiddenStart, hiddenEnd, "top")}
              />
            ) : (
              <>
                <ExpandButton
                  label="↓"
                  title={`Show ${CHUNK} more lines below line ${hiddenStart - 1}`}
                  busy={busy}
                  testId="hunk-gap-expand-down"
                  onClick={() => void reveal(hiddenStart, hiddenStart + CHUNK - 1, "top")}
                />
                <span aria-hidden="true">{hidden} hidden lines</span>
                <ExpandButton
                  label="↑"
                  title={`Show ${CHUNK} more lines above line ${hiddenEnd + 1}`}
                  busy={busy}
                  testId="hunk-gap-expand-up"
                  onClick={() => void reveal(hiddenEnd - CHUNK + 1, hiddenEnd, "bottom")}
                />
              </>
            )}
          </div>
        )}
        {error && (
          <div
            role="status"
            className={cn(BAR_CLASSES, "text-danger")}
            data-testid="hunk-gap-error"
          >
            {error}
          </div>
        )}
        {bottomRows}
      </div>
    );
  }

  const label = `View Collapsed Lines (line ${gap.afterNewLine})`;
  const content = (
    <>
      <span aria-hidden="true">⋯</span>
      <span>View Collapsed Lines</span>
      <span aria-hidden="true">⋯</span>
    </>
  );

  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(BAR_CLASSES, "cursor-pointer hover:bg-surface-muted hover:text-muted")}
        aria-label={label}
        title={label}
        data-testid="hunk-gap-placeholder"
      >
        {content}
      </a>
    );
  }

  return (
    <div
      className={BAR_CLASSES}
      role="presentation"
      title={label}
      data-testid="hunk-gap-placeholder"
    >
      {content}
    </div>
  );
}
