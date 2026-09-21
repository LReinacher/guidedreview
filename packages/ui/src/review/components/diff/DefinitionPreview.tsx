/**
 * The card a command-clicked identifier opens: where the symbol is declared,
 * the declaration itself, and the two ways out — jump to it inside the review,
 * or open the file in a new tab.
 */

import { useEffect, useLayoutEffect, useState, type RefObject } from "react";
import { Button, buttonClassName, cn, Spinner } from "@guided-review/ui";
import { highlightToLines, languageForPath } from "@guided-review/ui/review/highlight";
import { useReviewHost, type SymbolDefinition } from "@guided-review/ui/review/host";
import { useReviewStore } from "@guided-review/ui/review/store";
import type { SymbolLookup } from "@guided-review/ui/review/useSymbolNavigation";
import { trapTabKey } from "@guided-review/ui/review/focusTrap";
import { MiddleEllipsisText } from "@guided-review/ui/review/components/MiddleEllipsisText";

/** Card width, and the gap it keeps from the token and the viewport edges. */
const CARD_WIDTH = 560;
const GAP = 8;

export interface DefinitionJumpTarget {
  filePath: string;
  lineId?: string;
  hunkId?: string;
}

interface DefinitionPreviewProps {
  lookup: SymbolLookup;
  cardRef: RefObject<HTMLDivElement | null>;
  onClose: () => void;
  onShowDefinition: (index: number) => void;
  /** Present when the overlay can move the reader to a line in the diff. */
  onJump?: (target: DefinitionJumpTarget) => void;
}

function KindChip({ definition }: { definition: SymbolDefinition }) {
  return (
    <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-xs text-muted">
      {definition.kind ?? "declaration"}
    </span>
  );
}

/** The declaration and the lines under it, with real file line numbers. */
function Snippet({ definition }: { definition: SymbolDefinition }) {
  const language = languageForPath(definition.path);
  const highlighted = language
    ? highlightToLines(definition.snippet.join("\n"), language)
    : definition.snippet.map(() => null);

  return (
    <div
      // Scrollable, and `overscroll-contain` so reaching the end of the
      // snippet does not chain the wheel into the diff behind — which would
      // move the code under the card and close it.
      className="max-h-[min(26rem,50vh)] overflow-auto overscroll-contain bg-surface font-mono text-sm leading-relaxed"
      data-testid="definition-preview-snippet"
      tabIndex={0}
      role="group"
      aria-label={`Source of ${definition.path} from line ${definition.snippetStartLine}`}
    >
      {definition.snippet.map((content, index) => {
        const lineNumber = definition.snippetStartLine + index;
        const isDeclaration = lineNumber === definition.line;
        const fragment = highlighted[index] ?? null;
        return (
          <div
            key={lineNumber}
            className={cn(
              "flex min-w-0 whitespace-pre-wrap break-all px-3",
              isDeclaration && "bg-primary-muted",
            )}
          >
            <span
              className={cn(
                "w-10 shrink-0 select-none pr-3 text-right",
                isDeclaration ? "font-medium text-primary" : "text-faint",
              )}
            >
              {lineNumber}
            </span>
            <span className="min-w-0 flex-1">
              {fragment != null ? (
                <span dangerouslySetInnerHTML={{ __html: fragment }} />
              ) : (
                <span>{content}</span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function StatusBody({ lookup }: { lookup: SymbolLookup }) {
  if (lookup.status === "loading") {
    return (
      <div
        className="flex items-center gap-2 px-3 py-4 text-base text-muted"
        data-testid="definition-preview-loading"
      >
        <Spinner size={16} label="Looking for the declaration" />
        Looking for where <span className="font-mono text-foreground">{lookup.name}</span> is
        declared…
      </div>
    );
  }
  if (lookup.status === "error") {
    return (
      <p className="m-0 px-3 py-4 text-base text-muted" data-testid="definition-preview-error">
        Could not search this repo for{" "}
        <span className="font-mono text-foreground">{lookup.name}</span>. Try again, or open the
        file yourself.
      </p>
    );
  }
  return (
    <p className="m-0 px-3 py-4 text-base text-muted" data-testid="definition-preview-empty">
      No declaration of <span className="font-mono text-foreground">{lookup.name}</span> found. It
      may be imported from a dependency, or generated.
    </p>
  );
}

export function DefinitionPreview({
  lookup,
  cardRef,
  onClose,
  onShowDefinition,
  onJump,
}: DefinitionPreviewProps) {
  const host = useReviewHost();
  const prContext = useReviewStore((s) => s.prContext);
  const [placement, setPlacement] = useState<{ left: number; top: number } | null>(null);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const definition = lookup.definitions[lookup.index] ?? null;

  // Anchor to the token, flipping above it when the card would fall off screen.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const { height, width } = card.getBoundingClientRect();
    const { innerHeight, innerWidth } = window;
    const left = Math.max(GAP, Math.min(lookup.anchor.left, innerWidth - width - GAP));
    const below = lookup.anchor.bottom + GAP;
    const fitsBelow = below + height + GAP <= innerHeight;
    const above = lookup.anchor.top - height - GAP;
    const top = fitsBelow
      ? below
      : above >= GAP
        ? above
        : Math.max(GAP, innerHeight - height - GAP);
    setPlacement({ left, top });
  }, [cardRef, lookup.anchor, lookup.status, lookup.index, lookup.definitions.length]);

  // Focus moves into the card so the actions are reachable without the mouse,
  // and returns to wherever it was when the card goes away.
  useEffect(() => {
    const previous = document.activeElement;
    cardRef.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [cardRef]);

  useEffect(() => {
    if (!definition || !prContext || !host.fileLineUrl) {
      setFileUrl(null);
      return;
    }
    let cancelled = false;
    void host.fileLineUrl(definition.path, definition.line, prContext).then((url) => {
      if (!cancelled) setFileUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [definition, host, prContext]);

  const count = lookup.definitions.length;
  const canJump = Boolean(definition?.diffLineId && onJump);

  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-label={`Declaration of ${lookup.name}`}
      tabIndex={-1}
      // Above the overlay's own sticky file headers, inside the same stacking
      // context as the rest of the review.
      // `overscroll-contain` on the card as a whole stops a wheel over the
      // header or footer from chaining into the diff behind and scrolling the
      // card's own anchor away.
      className="fixed z-50 overflow-hidden overscroll-contain rounded-lg border border-border bg-surface-raised font-sans shadow-lg outline-none"
      style={{
        width: `min(${CARD_WIDTH}px, calc(100vw - ${GAP * 2}px))`,
        left: placement?.left ?? lookup.anchor.left,
        top: placement?.top ?? lookup.anchor.bottom + GAP,
        visibility: placement ? undefined : "hidden",
      }}
      onKeyDown={(event) => {
        if (event.key === "Tab" && cardRef.current) trapTabKey(event.nativeEvent, cardRef.current);
      }}
      data-testid="definition-preview"
    >
      <div className="flex items-center gap-2 border-b border-border bg-background px-3 py-2">
        <span className="shrink-0 font-mono text-sm text-foreground">{lookup.name}</span>
        {definition && <KindChip definition={definition} />}
        <span className="min-w-0 flex-1" />
        {count > 1 && (
          <span className="flex shrink-0 items-center gap-1 text-sm text-muted">
            <button
              type="button"
              className="cursor-pointer rounded px-1 text-muted hover:bg-surface-muted hover:text-foreground"
              aria-label="Previous declaration"
              onClick={() => onShowDefinition((lookup.index - 1 + count) % count)}
              data-testid="definition-preview-prev"
            >
              ‹
            </button>
            <span data-testid="definition-preview-count">
              {lookup.index + 1} of {count}
            </span>
            <button
              type="button"
              className="cursor-pointer rounded px-1 text-muted hover:bg-surface-muted hover:text-foreground"
              aria-label="Next declaration"
              onClick={() => onShowDefinition((lookup.index + 1) % count)}
              data-testid="definition-preview-next"
            >
              ›
            </button>
          </span>
        )}
        <button
          type="button"
          className="shrink-0 cursor-pointer rounded px-1.5 text-muted hover:bg-surface-muted hover:text-foreground"
          aria-label="Close declaration preview"
          onClick={onClose}
          data-testid="definition-preview-close"
        >
          ✕
        </button>
      </div>

      {definition ? (
        <>
          <div className="flex items-baseline gap-2 border-b border-border px-3 py-1.5">
            <MiddleEllipsisText
              text={`${definition.path}:${definition.line}`}
              maxWidth="100%"
              className="min-w-0 flex-1 font-mono text-sm text-muted"
            />
            {definition.diffLineId && (
              <span className="shrink-0 text-xs text-faint">in this review</span>
            )}
          </div>
          <Snippet definition={definition} />
          <div className="flex items-center justify-end gap-2 border-t border-border bg-background px-3 py-2">
            {canJump && (
              <Button
                size="sm"
                variant={fileUrl ? "secondary" : "primary"}
                onClick={() => {
                  onJump?.({
                    filePath: definition.path,
                    lineId: definition.diffLineId,
                    hunkId: definition.hunkId,
                  });
                  onClose();
                }}
                data-testid="definition-preview-jump"
              >
                Jump to It
              </Button>
            )}
            {fileUrl && (
              <a
                href={fileUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonClassName({ size: "sm" })}
                onClick={onClose}
                data-testid="definition-preview-open"
              >
                Open in New Tab
              </a>
            )}
          </div>
        </>
      ) : (
        <StatusBody lookup={lookup} />
      )}
    </div>
  );
}
