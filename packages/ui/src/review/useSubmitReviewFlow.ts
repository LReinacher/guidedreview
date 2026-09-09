import { useRef, useState } from "react";
import type { PRIdentity, ReviewCommentInput } from "@guided-review/ui/review/types";
import type { ReviewContext } from "@guided-review/core";
import { EMPTY_REVIEW_BODY_MESSAGE } from "@guided-review/ui/review/types";
import {
  githubComments,
  isLineComment,
  type DraftComment,
  type ReviewEvent,
  type ReviewSubmission,
} from "./commentTypes";
import { useReviewHost, type ReviewSubmitTarget } from "./host";

/** Map local draft comments to GitHub create-review `comments[]` payloads. */
function mapDraftsToReviewComments(drafts: DraftComment[]): ReviewCommentInput[] {
  return drafts.map((draft) => {
    // A whole-file comment carries no line anchor; GitHub wants subject_type.
    if (!isLineComment(draft)) {
      return { path: draft.filePath, body: draft.body, subjectType: "file" };
    }
    const comment: ReviewCommentInput = {
      path: draft.filePath,
      body: draft.body,
      side: draft.side,
      line: draft.endLine,
    };
    // GitHub 422s if start_line/start_side are sent on a single-line comment.
    if (draft.startLine !== draft.endLine) {
      comment.startLine = draft.startLine;
      comment.startSide = draft.side;
    }
    return comment;
  });
}

/** PR identity carried on a GitHub `ReviewContext`, when there is one. */
function identityFromContext(context: ReviewContext | null): PRIdentity | null {
  if (!context) return null;
  const { owner, repo, number } = context as Partial<PRIdentity>;
  if (typeof owner !== "string" || typeof repo !== "string" || typeof number !== "number") {
    return null;
  }
  return { owner, repo, number };
}

export interface SubmitSuccessInfo {
  event: ReviewEvent;
  commentCount: number;
}

interface UseSubmitReviewFlowOptions {
  prContext: ReviewContext | null;
  draftComments: DraftComment[];
  clearDraftComments: (target?: "github" | "local") => void;
  handleExit: () => void;
  overlayRef: React.RefObject<HTMLDivElement | null>;
  /**
   * Leave the review after a successful submit. False for the CLI, where the
   * process owns the window and there is nowhere to exit to.
   */
  exitOnSuccess?: boolean;
}

/**
 * Owns the Submit Review / Connect GitHub modal flow: auth-gated open,
 * target resolution, submission, success state, and post-submit exit.
 * Extracted from Overlay so the component itself stays focused on layout.
 *
 * Handlers are plain functions (not useCallback). useOverlayKeyboard mirrors
 * them into refs each render, and modal re-renders are cheap.
 */
export function useSubmitReviewFlow({
  prContext,
  draftComments,
  clearDraftComments,
  handleExit,
  overlayRef,
  exitOnSuccess = true,
}: UseSubmitReviewFlowOptions) {
  const host = useReviewHost();
  const [submitReviewOpen, setSubmitReviewOpen] = useState(false);
  const [connectGitHubOpen, setConnectGitHubOpen] = useState(false);
  const [submittingReview, setSubmittingReview] = useState(false);
  const [submitReviewError, setSubmitReviewError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState<SubmitSuccessInfo | null>(null);
  /** PR + placement warning for the open Submit Review modal. */
  const [submitTarget, setSubmitTarget] = useState<ReviewSubmitTarget | null>(null);
  /** Latest submit action from the open Submit Review modal (for ⌘/Ctrl+Enter). */
  const submitReviewActionRef = useRef<(() => void) | null>(null);
  /** Choose-step keys (↑/↓/Enter) for the open Submit Review modal. */
  const submitReviewKeyRef = useRef<((e: KeyboardEvent) => boolean) | null>(null);
  /** Primary Connect / Try again action from the open Connect GitHub modal. */
  const connectGitHubActionRef = useRef<(() => void) | null>(null);
  /** Ignore stale submit responses after the modal is closed or a newer submit. */
  const submitGenerationRef = useRef(0);
  /** Prevent double-open while auth status is in flight. */
  const authCheckInFlightRef = useRef(false);

  /** Only GitHub-bound drafts are posted; local notes stay on this machine. */
  const postableDrafts = githubComments(draftComments);

  function exitAfterSubmit(): void {
    setSubmitSuccess(null);
    if (prContext) {
      host.submit?.afterSubmit?.(prContext);
    }
    if (!exitOnSuccess) return;
    // Post-submit exit is intentional (single CTA) — skip the confirm prompt.
    handleExit();
  }

  function closeSubmitReviewModal(): void {
    if (submittingReview) return;
    setSubmitReviewOpen(false);
    setSubmitReviewError(null);
    // Return focus to the trigger so keyboard users are not dropped into limbo.
    requestAnimationFrame(() => {
      overlayRef.current
        ?.querySelector<HTMLElement>('[data-testid="submit-review-button"]')
        ?.focus();
    });
  }

  function closeConnectGitHubModal(): void {
    setConnectGitHubOpen(false);
  }

  function openSubmitReviewModalAfterAuth(): void {
    setConnectGitHubOpen(false);
    setSubmitReviewError(null);
    setSubmitReviewOpen(true);
    void loadSubmitTarget();
  }

  /**
   * Ask the host which PR this review posts to. Failure is not fatal: the
   * modal still opens and submit falls back to the PR identity in context.
   */
  async function loadSubmitTarget(): Promise<void> {
    const resolve = host.submit?.resolveTarget;
    if (!resolve) {
      const pr = identityFromContext(prContext);
      setSubmitTarget(pr ? { pr } : null);
      return;
    }
    try {
      setSubmitTarget(await resolve(prContext));
    } catch {
      setSubmitTarget(null);
    }
  }

  /**
   * Gate Submit Review on a stored GitHub token. Missing auth → connect modal;
   * after successful device OAuth the connect modal re-opens submit.
   */
  async function requestOpenSubmitReview(): Promise<void> {
    if (
      authCheckInFlightRef.current ||
      submitReviewOpen ||
      connectGitHubOpen ||
      submittingReview ||
      submitSuccess !== null
    ) {
      return;
    }

    if (!host.submit) return;

    authCheckInFlightRef.current = true;
    try {
      const status = await host.submit.getAuthStatus();
      if (status.ok && status.auth) {
        setSubmitReviewError(null);
        setSubmitReviewOpen(true);
        void loadSubmitTarget();
        return;
      }
      setConnectGitHubOpen(true);
    } catch {
      // Treat network/messaging failures as unauthenticated so the user can connect.
      setConnectGitHubOpen(true);
    } finally {
      authCheckInFlightRef.current = false;
    }
  }

  async function handleSubmitReview(submission: ReviewSubmission): Promise<void> {
    if (submittingReview) return;

    const trimmedBody = submission.body.trim();
    if (
      (submission.event === "COMMENT" || submission.event === "REQUEST_CHANGES") &&
      trimmedBody.length === 0
    ) {
      setSubmitReviewError(EMPTY_REVIEW_BODY_MESSAGE[submission.event]);
      return;
    }

    const pr = submitTarget?.pr ?? identityFromContext(prContext);
    if (!pr) {
      setSubmitReviewError(
        "No pull request to post this review to. Open a PR for this branch and try again.",
      );
      return;
    }

    const submit = host.submit;
    if (!submit) {
      setSubmitReviewError("This host cannot submit a GitHub review.");
      return;
    }

    const generation = ++submitGenerationRef.current;
    setSubmittingReview(true);
    setSubmitReviewError(null);

    const comments = mapDraftsToReviewComments(postableDrafts);

    try {
      const result = await submit.submitReview(pr, trimmedBody, submission.event, comments);

      if (generation !== submitGenerationRef.current) return;

      if (!result.ok) {
        setSubmitReviewError(result.error);
        return;
      }

      // Posted comments are gone from the draft list; local-only notes are not
      // part of the submission and stay for the coding-agent prompt.
      clearDraftComments("github");
      setSubmitReviewOpen(false);
      setSubmitReviewError(null);
      setSubmitSuccess({ event: submission.event, commentCount: comments.length });
    } catch (error: unknown) {
      if (generation !== submitGenerationRef.current) return;
      const message = error instanceof Error ? error.message : "Could not submit the review.";
      setSubmitReviewError(message);
    } finally {
      if (generation === submitGenerationRef.current) {
        setSubmittingReview(false);
      }
    }
  }

  return {
    submitReviewOpen,
    connectGitHubOpen,
    submittingReview,
    submitReviewError,
    submitSuccess,
    submitTarget,
    postableCount: postableDrafts.length,
    submitReviewActionRef,
    submitReviewKeyRef,
    connectGitHubActionRef,
    exitAfterSubmit,
    closeSubmitReviewModal,
    closeConnectGitHubModal,
    openSubmitReviewModalAfterAuth,
    requestOpenSubmitReview,
    handleSubmitReview,
  };
}
