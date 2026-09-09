import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { formatLineRangeLabel, type CommentTarget } from "@guided-review/ui/review/commentTypes";
import { useOptionalReviewHost } from "@guided-review/ui/review/host";
import { Button, Kbd, Textarea } from "@guided-review/ui";
import { CommentTargetSwitch } from "./CommentTargetSwitch";
import { ModEnterChord } from "./ShortcutKeys";

interface CommentComposerProps {
  filePath: string;
  /** Omit both for a whole-file comment. */
  startLine?: number;
  endLine?: number;
  onSave: (body: string, target: CommentTarget) => void;
  onCancel: () => void;
}

/**
 * Inline markdown draft composer. Enter inserts a newline;
 * ⌘/Ctrl+Enter saves; Esc cancels.
 */
export function CommentComposer({
  filePath,
  startLine,
  endLine,
  onSave,
  onCancel,
}: CommentComposerProps) {
  const host = useOptionalReviewHost();
  // Without a submit host there is nowhere to post to, so every comment is local.
  const canPost = Boolean(host?.submit);
  const [body, setBody] = useState("");
  const [target, setTarget] = useState<CommentTarget>(canPost ? "github" : "local");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isFileComment = startLine === undefined || endLine === undefined;

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const canSave = body.trim().length > 0;

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.stopPropagation();
      if (canSave) onSave(body, target);
    }
  }

  return (
    <div
      className="border border-border bg-background px-3 py-3"
      data-testid="comment-composer"
      role="form"
      aria-label="Draft review comment"
    >
      <div className="mb-2 font-mono text-sm text-muted">
        {startLine === undefined || endLine === undefined
          ? `${filePath} (whole file)`
          : formatLineRangeLabel(filePath, startLine, endLine)}
      </div>
      <Textarea
        ref={textareaRef}
        placeholder={
          isFileComment
            ? "File comment (markdown supported)…"
            : "Line comment (markdown supported)…"
        }
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={handleKeyDown}
        aria-label="Comment body"
        data-testid="comment-composer-input"
      />
      <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
        {canPost && (
          <CommentTargetSwitch
            value={target}
            onChange={setTarget}
            className="mr-auto"
            testId="comment-composer-target"
          />
        )}
        <Button variant="secondary" size="sm" onClick={onCancel}>
          Cancel
          <Kbd>Esc</Kbd>
        </Button>
        <Button
          size="sm"
          disabled={!canSave}
          onClick={() => {
            if (canSave) onSave(body, target);
          }}
          data-testid="comment-composer-save"
          className="disabled:opacity-40"
        >
          Save Draft
          <ModEnterChord />
        </Button>
      </div>
    </div>
  );
}
