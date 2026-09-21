/**
 * The file a declaration opens in a new tab.
 *
 * Deliberately its own document rather than a panel in the review: following a
 * symbol should never cost the reader their place in the walkthrough, and a
 * tab is the thing every reviewer already knows how to keep, close, or park on
 * a second monitor.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { cn, Spinner } from "@guided-review/ui";
import { highlightToLines, languageForPath } from "@guided-review/ui/review/highlight";
import type { SourceFilePayload } from "../../server/createServer";
import { parseAppHash } from "../routes";

interface SourceRequest {
  path: string;
  /** 1-indexed line to highlight and scroll to, when the link carried one. */
  line: number | null;
}

function readRequest(): SourceRequest | null {
  const { params } = parseAppHash(window.location.hash);
  const path = params.get("path");
  if (!path) return null;
  const line = Number(params.get("line"));
  return { path, line: Number.isInteger(line) && line > 0 ? line : null };
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; file: SourceFilePayload };

function Chrome({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-surface font-sans text-base text-foreground antialiased">
      <header className="sticky top-0 z-10 border-b border-border bg-background px-4 py-3 md:px-6">
        <h1 className="m-0 font-mono text-base break-all text-foreground" data-testid="source-path">
          {title}
        </h1>
      </header>
      <main className="px-4 py-4 md:px-6">{children}</main>
    </div>
  );
}

export function SourceView({ request }: { request: SourceRequest }) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const targetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.title = `${request.path.split("/").pop() ?? request.path} — Guided Review`;
  }, [request.path]);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void (async () => {
      try {
        const res = await fetch(`/api/source?path=${encodeURIComponent(request.path)}`);
        const body = (await res.json().catch(() => null)) as
          (SourceFilePayload & { error?: string }) | null;
        if (cancelled) return;
        if (!res.ok || !body?.lines) {
          setState({ status: "error", message: body?.error ?? "Could not read that file." });
          return;
        }
        setState({ status: "ready", file: body });
      } catch {
        if (!cancelled) {
          setState({ status: "error", message: "Lost connection to the local review server." });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [request.path]);

  const file = state.status === "ready" ? state.file : null;
  const highlighted = useMemo(() => {
    if (!file) return null;
    const language = languageForPath(file.path);
    return language ? highlightToLines(file.lines.join("\n"), language) : null;
  }, [file]);

  // Land on the declaration, not the top of the file.
  useEffect(() => {
    if (state.status !== "ready") return;
    targetRef.current?.scrollIntoView({ block: "center" });
  }, [state.status]);

  if (state.status === "loading") {
    return (
      <Chrome title={request.path}>
        <p className="flex items-center gap-2 text-muted">
          <Spinner size={16} label="Loading the file" />
          Reading {request.path}…
        </p>
      </Chrome>
    );
  }

  if (state.status === "error") {
    return (
      <Chrome title={request.path}>
        <p className="text-muted" data-testid="source-error">
          {state.message}
        </p>
      </Chrome>
    );
  }

  return (
    <Chrome title={`${state.file.path}${request.line ? `:${request.line}` : ""}`}>
      <div className="overflow-hidden rounded-lg border border-border bg-surface-raised">
        <div
          className="overflow-x-auto font-mono text-sm leading-relaxed"
          data-testid="source-code"
        >
          {state.file.lines.map((content, index) => {
            const lineNumber = index + 1;
            const isTarget = lineNumber === request.line;
            const fragment = highlighted?.[index] ?? null;
            return (
              <div
                key={lineNumber}
                ref={isTarget ? targetRef : undefined}
                id={`L${lineNumber}`}
                className={cn(
                  "flex min-w-0 whitespace-pre-wrap break-all pr-3",
                  isTarget && "bg-primary-muted",
                )}
                data-testid={isTarget ? "source-target-line" : undefined}
              >
                <span
                  className={cn(
                    "w-14 shrink-0 select-none pr-3 text-right",
                    isTarget ? "bg-primary font-medium text-primary-foreground" : "text-faint",
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
      </div>
      {state.file.truncated && (
        <p className="mt-3 text-muted" data-testid="source-truncated">
          This file is longer than the viewer shows. Open it in your editor for the rest.
        </p>
      )}
    </Chrome>
  );
}

/**
 * Source-viewer document. The root component is chosen at boot, so a hash
 * change back to the review (the browser's Back button) reloads into the
 * review app rather than leaving a stale viewer on screen.
 */
export function SourceApp() {
  const [request, setRequest] = useState<SourceRequest | null>(() => readRequest());

  useEffect(() => {
    function onHashChange(): void {
      if (parseAppHash(window.location.hash).name !== "source") {
        window.location.reload();
        return;
      }
      setRequest(readRequest());
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  if (!request) {
    return (
      <Chrome title="No file">
        <p className="text-muted">That link did not say which file to open.</p>
      </Chrome>
    );
  }

  return <SourceView key={request.path} request={request} />;
}
