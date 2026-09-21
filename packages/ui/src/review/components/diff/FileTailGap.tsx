import { useEffect, useState } from "react";
import { useReviewHost } from "@guided-review/ui/review/host";
import { useReviewStore } from "@guided-review/ui/review/store";
import type { FileTail, HunkGap } from "@guided-review/ui/review/hunkGaps";
import { HunkGapPlaceholder } from "./HunkGapPlaceholder";

interface FileTailGapProps {
  filePath: string;
  tail: FileTail;
  onExpandedChange?: (key: string, expanded: boolean) => void;
}

/**
 * The rest of the file below the last displayed hunk.
 *
 * A patch ends at its last hunk and says nothing about what follows, so the
 * file's length has to come from the host before there is a gap to draw. When
 * the hunk already runs to the end of the file, nothing is drawn at all.
 */
export function FileTailGap({ filePath, tail, onExpandedChange }: FileTailGapProps) {
  const host = useReviewHost();
  const prContext = useReviewStore((s) => s.prContext);
  const [totalLines, setTotalLines] = useState<number | null>(null);

  useEffect(() => {
    if (!host.fileLineCount || !prContext) return;
    let cancelled = false;
    void host
      .fileLineCount({ path: filePath, side: "new", context: prContext })
      .then((total) => {
        if (!cancelled) setTotalLines(total);
      })
      // A file we cannot measure is one we cannot extend into; stay silent
      // rather than putting an error bar under an otherwise fine diff.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [host, prContext, filePath]);

  const size = totalLines == null ? 0 : totalLines - tail.afterNewLine;
  if (totalLines == null || size <= 0) return null;

  const gap: HunkGap = {
    kind: "gap",
    key: tail.key,
    afterOldLine: tail.afterOldLine,
    afterNewLine: tail.afterNewLine,
    // One line past the end of the file on each side: nothing is changed down
    // here, so both sides advance in lockstep from the last hunk.
    beforeOldLine: tail.afterOldLine + size + 1,
    beforeNewLine: totalLines + 1,
    size,
  };

  return <HunkGapPlaceholder filePath={filePath} gap={gap} onExpandedChange={onExpandedChange} />;
}
