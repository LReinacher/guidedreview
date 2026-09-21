import type { CommentTarget } from "@guided-review/ui/review/commentTypes";
import { Button, cn } from "@guided-review/ui";

interface CommentTargetSwitchProps {
  value: CommentTarget;
  onChange: (target: CommentTarget) => void;
  className?: string;
  testId?: string;
}

const OPTIONS: { value: CommentTarget; label: string; title: string }[] = [
  {
    value: "github",
    label: "GitHub",
    title: "Post this comment on the pull request when the review is submitted",
  },
  {
    value: "local",
    label: "Local",
    title: "Keep this comment on this machine — prompt only, never posted",
  },
];

/**
 * Where a comment goes: onto the pull request with the submitted review, or
 * only into the coding-agent prompt. Shown wherever the host can submit to
 * GitHub; when it cannot, comments are local by definition and this is hidden.
 */
export function CommentTargetSwitch({
  value,
  onChange,
  className,
  testId,
}: CommentTargetSwitchProps) {
  return (
    <div
      role="group"
      aria-label="Comment destination"
      data-testid={testId}
      data-target={value}
      className={cn(
        "flex items-center rounded-md border border-border bg-background p-0.5",
        className,
      )}
    >
      {OPTIONS.map((option) => (
        <Button
          key={option.value}
          type="button"
          size="sm"
          variant={value === option.value ? "primary" : "ghost"}
          className="px-2 py-0.5 text-xs"
          aria-pressed={value === option.value}
          title={option.title}
          data-testid={testId ? `${testId}-${option.value}` : undefined}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}
