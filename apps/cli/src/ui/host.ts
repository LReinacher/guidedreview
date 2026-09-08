import type { AnnotateReviewStreamEvent, ParsedDiff, ReviewContext } from "@guided-review/core";
import type { ReviewHost, StreamPlanHandlers } from "@guided-review/ui/review/host";
import type { DiffViewMode } from "@guided-review/ui/review/diffView";

export function createLocalReviewHost(options: { onConnectProvider: () => void }): ReviewHost {
  const { onConnectProvider } = options;

  return {
    kind: "local",
    assetUrl: (path) => `/${path.replace(/^\/+/, "")}`,
    persistSession: async (key, data) => {
      sessionStorage.setItem(`guidedReview.session.${key}`, JSON.stringify(data));
    },
    restoreSession: async (key) => {
      const raw = sessionStorage.getItem(`guidedReview.session.${key}`);
      return raw ? (JSON.parse(raw) as unknown) : null;
    },
    streamPlan: (_diff: ParsedDiff, _context: ReviewContext, handlers: StreamPlanHandlers) => {
      const source = new EventSource("/api/plan");
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        source.close();
        fn();
      };
      source.onmessage = (event) => {
        let message: AnnotateReviewStreamEvent;
        try {
          message = JSON.parse(event.data) as AnnotateReviewStreamEvent;
        } catch {
          finish(() =>
            handlers.onError({ message: "The local review server sent an unreadable response." }),
          );
          return;
        }
        switch (message.type) {
          case "STATUS":
            handlers.onStatus?.(message.phase);
            return;
          case "UNIT":
            handlers.onUnit(message.unit);
            return;
          case "DONE":
            finish(() => handlers.onDone(message.plan));
            return;
          case "ERROR":
            finish(() => handlers.onError(message.error));
            return;
        }
      };
      source.onerror = () => {
        finish(() => handlers.onError({ message: "Lost connection to the local review server." }));
      };
      return {
        cancel: () => finish(() => {}),
      };
    },
    connectProvider: onConnectProvider,
    persistDiffViewMode: async (mode: DiffViewMode) => {
      localStorage.setItem("guidedReview.diffViewMode", mode);
    },
    readDiffViewMode: async () => {
      const raw = localStorage.getItem("guidedReview.diffViewMode");
      return raw === "unified" || raw === "split" ? raw : "split";
    },
    filePreviewUrl: async ({ path, side }) => {
      const params = new URLSearchParams({ path, side });
      return `/api/file?${params.toString()}`;
    },
    // Present, so the overlay expands collapsed gaps in place rather than
    // falling back to a link (there is nowhere to link to in a local review).
    fileLines: async ({ path, side, startLine, endLine }) => {
      const params = new URLSearchParams({
        path,
        side,
        start: String(startLine),
        end: String(endLine),
      });
      const res = await fetch(`/api/file-lines?${params.toString()}`);
      if (!res.ok) return null;
      const data = (await res.json()) as { lines?: string[] };
      return data.lines ?? null;
    },
    // Capability flag only — Overlay owns Generate Prompt UI + clipboard.
    exportNotes: () => {},
  };
}
