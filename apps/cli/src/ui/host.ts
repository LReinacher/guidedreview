import type { AnnotateReviewStreamEvent, ParsedDiff, ReviewContext } from "@guided-review/core";
import type { SubmitReviewResponse } from "@guided-review/ui/review/types";
import type {
  ReviewHost,
  ReviewSubmitTarget,
  StreamPlanHandlers,
} from "@guided-review/ui/review/host";
import type { DiffViewMode } from "@guided-review/ui/review/diffView";
import type { GitHubStatusPayload } from "../server/createServer";
import { ConnectGitHubDialog } from "./ConnectGitHubDialog";

/**
 * Coalesce session writes. The overlay re-persists on every unit change and
 * every keystroke-sized comment edit, and each write carries the whole diff
 * and plan — one trailing write per burst keeps that off the hot path without
 * risking the state the user actually ended on.
 */
const PERSIST_DEBOUNCE_MS = 400;

function createSessionWriter() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: { key: string; state: unknown } | null = null;

  async function flush(): Promise<void> {
    const next = pending;
    pending = null;
    if (!next) return;
    await fetch("/api/review-state", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(next),
    });
  }

  // Best-effort flush of the debounce window when the tab goes away. The
  // payload is far past the 64kb `sendBeacon` ceiling, so this is a plain
  // request to loopback; if the browser kills it, at most the last few hundred
  // milliseconds of edits are lost.
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", () => {
      if (timer) clearTimeout(timer);
      void flush().catch(() => {});
    });
  }

  return (key: string, state: unknown): Promise<void> => {
    pending = { key, state };
    if (timer) clearTimeout(timer);
    return new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        flush().then(resolve, reject);
      }, PERSIST_DEBOUNCE_MS);
    });
  };
}

/** One writer per page: the host is rebuilt when GitHub status lands. */
const writeSession = createSessionWriter();

async function readGitHubStatus(): Promise<GitHubStatusPayload | null> {
  try {
    const res = await fetch("/api/github");
    if (!res.ok) return null;
    return (await res.json()) as GitHubStatusPayload;
  } catch {
    return null;
  }
}

function prLabel(status: GitHubStatusPayload): string | undefined {
  const pr = status.pullRequest;
  return pr ? `${pr.owner}/${pr.repo}#${pr.number}` : undefined;
}

export function createLocalReviewHost(options: {
  onConnectProvider: () => void;
  /** Null until the GitHub probe resolves, or when there is nothing to post to. */
  github?: GitHubStatusPayload | null;
}): ReviewHost {
  const { onConnectProvider, github } = options;

  return {
    kind: "local",
    assetUrl: (path) => `/${path.replace(/^\/+/, "")}`,
    // Reviews live in the git dir, not the tab: restarting the CLI after a
    // crash resumes the same structure, position, and comments.
    persistPartialSessions: true,
    persistSession: (key, state) => writeSession(key, state),
    restoreSession: async (key) => {
      const res = await fetch(`/api/review-state?key=${encodeURIComponent(key)}`);
      if (!res.ok) return null;
      const body = (await res.json()) as { state?: unknown };
      return body.state ?? null;
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
    // Offered as soon as the branch has a pull request to post to. Missing or
    // rejected credentials are a step inside the flow (the connect dialog),
    // not a reason to hide it. With no PR at all there is nothing to submit to
    // and Generate Prompt is the whole story, exactly as before.
    submit: github?.pullRequest
      ? {
          ConnectionDialog: ConnectGitHubDialog,
          getAuthStatus: async () => {
            const status = await readGitHubStatus();
            return {
              ok: true as const,
              auth: status?.available && status.login ? { login: status.login } : null,
            };
          },
          resolveTarget: async (): Promise<ReviewSubmitTarget | null> => {
            // Re-read rather than trusting boot state: the warning depends on
            // the diff scope the user has since chosen.
            const status = (await readGitHubStatus()) ?? github;
            const pr = status.pullRequest;
            if (!pr) return null;
            return {
              pr: { owner: pr.owner, repo: pr.repo, number: pr.number },
              label: prLabel(status),
              warning: status.warning,
            };
          },
          submitReview: async (_pr, body, event, comments): Promise<SubmitReviewResponse> => {
            // The server owns the PR identity and the token; sending them from
            // the browser would only let a stale tab post somewhere else.
            const res = await fetch("/api/github/review", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ body, event, comments }),
            });
            const parsed = (await res.json().catch(() => null)) as SubmitReviewResponse | null;
            if (!parsed) {
              return { ok: false, code: "unknown", error: "The local server sent no response." };
            }
            return parsed;
          },
        }
      : undefined,
    // Capability flag only — Overlay owns Generate Prompt UI + clipboard.
    exportNotes: () => {},
  };
}
