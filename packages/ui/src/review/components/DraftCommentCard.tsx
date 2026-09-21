import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  formatCommentAnchor,
  type CommentTarget,
  type DraftComment,
} from "@guided-review/ui/review/commentTypes";
import { useOptionalReviewHost } from "@guided-review/ui/review/host";
import { Button, Kbd, Textarea } from "@guided-review/ui";
import { CommentTargetSwitch } from "./CommentTargetSwitch";
import { ModEnterChord } from "./ShortcutKeys";

interface DraftCommentCardProps {
  comment: DraftComment;
  onRemove: (id: string) => void;
  onUpdate: (id: string, body: string) => void;
  onTargetChange?: (id: string, target: CommentTarget) => void;
}

/** Compact local draft shown under the commented line range. */
export function DraftCommentCard({
  comment,
  onRemove,
  onUpdate,
  onTargetChange,
}: DraftCommentCardProps) {
  const host = useOptionalReviewHost();
  const canPost = Boolean(host?.submit) && Boolean(onTargetChange);
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(comment.body);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) return;
    setBody(comment.body);
    textareaRef.current?.focus();
    // Move caret to end so the user can keep typing.
    const el = textareaRef.current;
    if (el) {
      const len = el.value.length;
      el.setSelectionRange(len, len);
    }
  }, [editing, comment.body]);

  const canSave = body.trim().length > 0;

  function exitEdit(): void {
    setEditing(false);
    setBody(comment.body);
  }

  function saveEdit(): void {
    if (!canSave) return;
    onUpdate(comment.id, body);
    setEditing(false);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      exitEdit();
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.stopPropagation();
      if (canSave) saveEdit();
    }
  }

  return (
    <div
      className="border-y border-border bg-surface px-3 py-2.5"
      data-testid="draft-comment"
      data-draft-id={comment.id}
      data-draft-scope={comment.scope}
      data-draft-target={comment.target}
    >
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-xs text-muted">
          {comment.target === "github" ? "Pending" : "Note"} · {formatCommentAnchor(comment)}
        </span>
        <div className="flex items-center gap-1">
          {canPost && (
            <CommentTargetSwitch
              value={comment.target}
              onChange={(target) => onTargetChange?.(comment.id, target)}
              className="mr-1"
              testId="draft-comment-target"
            />
          )}
          {!editing && (
            <button
              type="button"
              className="cursor-pointer rounded px-1.5 py-0.5 text-sm text-muted hover:bg-surface-muted hover:text-foreground"
              onClick={() => setEditing(true)}
              aria-label="Edit draft comment"
              data-testid="draft-comment-edit"
            >
              Edit
            </button>
          )}
          <button
            type="button"
            className="cursor-pointer rounded px-1.5 py-0.5 text-sm text-muted hover:bg-surface-muted hover:text-foreground"
            onClick={() => onRemove(comment.id)}
            aria-label="Remove draft comment"
            data-testid="draft-comment-remove"
          >
            Remove
          </button>
        </div>
      </div>
      {editing ? (
        <>
          <Textarea
            ref={textareaRef}
            className="bg-background"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={handleKeyDown}
            aria-label="Edit comment body"
            data-testid="draft-comment-edit-input"
          />
          <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
            <Button
              variant="secondary"
              size="sm"
              className="bg-background"
              onClick={exitEdit}
              data-testid="draft-comment-edit-cancel"
            >
              Cancel
              <Kbd>Esc</Kbd>
            </Button>
            <Button
              size="sm"
              disabled={!canSave}
              onClick={saveEdit}
              data-testid="draft-comment-edit-save"
              className="disabled:opacity-40"
            >
              Save
              <ModEnterChord />
            </Button>
          </div>
        </>
      ) : (
        <div
          className="whitespace-pre-wrap font-sans text-base leading-relaxed text-foreground"
          data-testid="draft-comment-body"
        >
          {comment.body}
        </div>
      )}
    </div>
  );
}
