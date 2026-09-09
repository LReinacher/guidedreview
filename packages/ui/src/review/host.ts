/**
 * Host adapter for the review overlay. GitHub and the local CLI implement
 * this; the marketing preview simulates either host without importing app code.
 */

import {
  createContext,
  createElement,
  useContext,
  type ReactNode,
  type ComponentType,
  type RefObject,
} from "react";
import type {
  ParsedDiff,
  PRIdentity,
  ReviewContext,
  ReviewErrorInfo,
  ReviewPlan,
  ReviewUnit,
  SubmitReviewResponse,
} from "@guided-review/ui/review/types";
import type { ReviewCommentInput, ReviewEvent } from "@guided-review/ui/review/types";
import type { DiffViewMode } from "./diffView";
import type { DraftComment } from "./commentTypes";

export interface StreamPlanHandlers {
  onUnit: (unit: ReviewUnit) => void;
  onDone: (plan: ReviewPlan) => void;
  onError: (error: ReviewErrorInfo) => void;
  onStatus?: (phase: "waiting_for_tokens" | "tokens_streaming") => void;
}

export interface ReviewSubmitAuth {
  login: string;
  avatarUrl?: string;
  name?: string;
}

/** The pull request a review would be posted to, resolved at submit time. */
export interface ReviewSubmitTarget {
  pr: PRIdentity;
  /** Human label for the dialog, e.g. `acme/widget#42`. */
  label?: string;
  /**
   * Non-blocking caution about this submission — typically that the reviewed
   * diff does not match the PR head, so inline comments may not line up.
   */
  warning?: string | null;
}

export interface ReviewHostSubmit {
  ConnectionDialog?: ComponentType<ReviewConnectionProps>;
  getAuthStatus(): Promise<{ ok: true; auth: ReviewSubmitAuth | null }>;
  /**
   * Which PR to post to. The GitHub host reads it off the page context it is
   * already running on; the CLI has to ask its server which PR the checked-out
   * branch belongs to. Hosts that omit this fall back to the PR identity in
   * `ReviewContext`.
   */
  resolveTarget?(context: ReviewContext | null): Promise<ReviewSubmitTarget | null>;
  submitReview(
    pr: PRIdentity,
    body: string,
    event: ReviewEvent,
    comments: ReviewCommentInput[],
  ): Promise<SubmitReviewResponse>;
  afterSubmit?(context: ReviewContext): void;
}

export interface ReviewConnectionProps {
  open: boolean;
  onClose: () => void;
  onAuthenticated: () => void;
  connectActionRef?: RefObject<(() => void) | null>;
}

export type FilePreviewSide = "old" | "new";

export interface FilePreviewRequest {
  path: string;
  previousPath?: string;
  side: FilePreviewSide;
  context: ReviewContext;
}

export interface FileLinesRequest {
  path: string;
  side: FilePreviewSide;
  /** 1-indexed, inclusive. */
  startLine: number;
  endLine: number;
  context: ReviewContext;
}

export interface ReviewHost {
  kind: "github" | "local";
  /** Marketing demo controls. The underlying kind still drives the real host UI. */
  preview?: {
    mode: "cli" | "chrome";
    onModeChange(mode: "cli" | "chrome"): void;
  };
  assetUrl(path: string): string;
  persistSession(key: string, data: unknown): Promise<void>;
  restoreSession(key: string): Promise<unknown | null>;
  /**
   * Persist sessions that have not been AI-structured yet. Hosts whose storage
   * is durable (the CLI writes into the git dir) turn this on so a crash never
   * costs the user their comments; the extension keeps only AI plans, which is
   * all a browser session needs to avoid a repeat provider call.
   */
  persistPartialSessions?: boolean;
  streamPlan(
    diff: ParsedDiff,
    context: ReviewContext,
    handlers: StreamPlanHandlers,
  ): { cancel(): void };
  connectProvider(): void;
  persistDiffViewMode?(mode: DiffViewMode): Promise<void>;
  readDiffViewMode?(): Promise<DiffViewMode>;
  fileDiffUrl?(filePath: string, context: ReviewContext): Promise<string | null>;
  fileLineUrl?(filePath: string, line: number, context: ReviewContext): Promise<string | null>;
  /**
   * URL the overlay can put in `<img src>` for one side of an image file.
   * GitHub returns a `data:` URL (CSP + private repos); the CLI returns `/api/file`.
   */
  filePreviewUrl?(request: FilePreviewRequest): Promise<string | null>;
  /**
   * Source lines `[startLine, endLine]` (1-indexed, inclusive) from one side of
   * a file. When a host implements this, the overlay expands the collapsed
   * gaps between hunks in place; when it does not, the gap falls back to
   * `fileLineUrl` (GitHub opens the file at that line instead).
   */
  fileLines?(request: FileLinesRequest): Promise<string[] | null>;
  submit?: ReviewHostSubmit;
  /**
   * Enables Generate Prompt. With submit it is a secondary action;
   * otherwise it is primary. Overlay owns formatting and copying.
   */
  exportNotes?: (drafts: DraftComment[]) => void | Promise<void>;
}

const ReviewHostContext = createContext<ReviewHost | null>(null);

let activeHost: ReviewHost | null = null;

export function setActiveReviewHost(host: ReviewHost | null): void {
  activeHost = host;
}

export function getActiveReviewHost(): ReviewHost | null {
  return activeHost;
}

export function ReviewHostProvider({ host, children }: { host: ReviewHost; children: ReactNode }) {
  setActiveReviewHost(host);
  return createElement(ReviewHostContext.Provider, { value: host }, children);
}

/**
 * The host if one is set, else null. For leaf components that only vary a
 * detail on a host capability (can this review be posted to GitHub?) and must
 * still render standalone.
 */
export function useOptionalReviewHost(): ReviewHost | null {
  const fromContext = useContext(ReviewHostContext);
  return fromContext ?? activeHost;
}

export function useReviewHost(): ReviewHost {
  const host = useOptionalReviewHost();
  if (!host) {
    throw new Error("ReviewHost is not set. Wrap the overlay in ReviewHostProvider.");
  }
  return host;
}

/** In-memory host for unit tests. */
export function createMemoryReviewHost(overrides: Partial<ReviewHost> = {}): ReviewHost {
  const sessions = new Map<string, unknown>();
  let diffViewMode: DiffViewMode = "split";
  return {
    kind: "github",
    assetUrl: (path) => path,
    persistSession: async (key, data) => {
      sessions.set(key, data);
    },
    restoreSession: async (key) => sessions.get(key) ?? null,
    streamPlan: () => ({ cancel() {} }),
    connectProvider: () => {},
    persistDiffViewMode: async (mode) => {
      diffViewMode = mode;
    },
    readDiffViewMode: async () => diffViewMode,
    ...overrides,
  };
}
