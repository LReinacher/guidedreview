/**
 * Shapes shared by every host that can submit a GitHub pull request review:
 * the Chrome extension (OAuth device token) and the CLI (`gh` / env token).
 */

export interface PRIdentity {
  owner: string;
  repo: string;
  number: number;
}

export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

export interface ReviewCommentInput {
  path: string;
  body: string;
  /** Omitted for a whole-file comment (`subjectType: "file"`). */
  side?: "LEFT" | "RIGHT";
  line?: number;
  startLine?: number;
  startSide?: "LEFT" | "RIGHT";
  /** GitHub `subject_type`. Defaults to a line comment when absent. */
  subjectType?: "file";
}

export type SubmitReviewResponse =
  | { ok: true; reviewId: number; htmlUrl: string }
  | {
      ok: false;
      error: string;
      code?: "not_authenticated" | "forbidden" | "not_found" | "validation" | "network" | "unknown";
    };

export const EMPTY_REVIEW_BODY_MESSAGE: Record<"COMMENT" | "REQUEST_CHANGES", string> = {
  COMMENT: "Add a review comment before submitting.",
  REQUEST_CHANGES: "Add a summary explaining the requested changes before submitting.",
};
