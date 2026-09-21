import { useEffect, useId, useState } from "react";
import { Button, CloseButton, Kbd, ModalShell, Spinner } from "@guided-review/ui";
import type { ReviewConnectionProps } from "@guided-review/ui/review/host";
import type { GitHubStatusPayload } from "../server/createServer";

/**
 * The CLI does not run its own OAuth app — it borrows whatever credentials the
 * machine already has (`gh auth login`, or GH_TOKEN / GITHUB_TOKEN). So this
 * dialog explains what is missing and re-checks, rather than starting a flow.
 */
export function ConnectGitHubDialog({
  open,
  onClose,
  onAuthenticated,
  connectActionRef,
}: ReviewConnectionProps) {
  const titleId = useId();
  const [checking, setChecking] = useState(false);
  const [reason, setReason] = useState<string | null>(null);

  async function recheck(): Promise<void> {
    setChecking(true);
    try {
      const res = await fetch("/api/github");
      const status = res.ok ? ((await res.json()) as GitHubStatusPayload) : null;
      if (status?.available) {
        setReason(null);
        onAuthenticated();
        return;
      }
      setReason(status?.reason ?? "Could not reach the local review server.");
    } catch {
      setReason("Could not reach the local review server.");
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    void recheck();
    // Re-probing on open is the whole point; the deps would only re-run it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Overlay capture keyboard owns real keystrokes; expose the primary action.
  useEffect(() => {
    if (!connectActionRef) return;
    connectActionRef.current = open && !checking ? () => void recheck() : null;
    return () => {
      connectActionRef.current = null;
    };
  });

  if (!open) return null;

  return (
    <ModalShell
      scrimTestId="connect-github-scrim"
      onScrimDismiss={onClose}
      maxWidthClassName="max-w-[480px]"
      panelProps={{
        role: "dialog",
        "aria-modal": "true",
        "aria-labelledby": titleId,
        "data-testid": "connect-github-modal",
      }}
    >
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <h2 id={titleId} className="m-0 text-lg font-semibold text-foreground">
          Connect GitHub
        </h2>
        <CloseButton onClick={onClose} testId="connect-github-close" />
      </div>

      <div className="flex flex-col gap-3 px-4 py-4">
        <p className="m-0 text-base leading-relaxed text-muted">
          Guided Review posts reviews with the GitHub credentials this machine already has.
        </p>
        <ol className="m-0 flex list-decimal flex-col gap-1.5 pl-5 text-base text-foreground">
          <li>
            Run{" "}
            <code className="rounded bg-surface px-1 py-0.5 font-mono text-sm">gh auth login</code>{" "}
            in a terminal, or export{" "}
            <code className="rounded bg-surface px-1 py-0.5 font-mono text-sm">GITHUB_TOKEN</code>{" "}
            and restart guidedreview.
          </li>
          <li>Come back here and check again.</li>
        </ol>
        {reason && (
          <p
            className="m-0 rounded-md border border-border bg-surface px-3 py-2 text-base leading-snug text-muted"
            role="status"
            data-testid="connect-github-reason"
          >
            {reason}
          </p>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
        <Button variant="secondary" size="sm" onClick={onClose} data-testid="connect-github-cancel">
          Cancel
          <Kbd>Esc</Kbd>
        </Button>
        <Button
          size="sm"
          onClick={() => void recheck()}
          disabled={checking}
          data-testid="connect-github-recheck"
        >
          {checking ? <Spinner /> : null}
          {checking ? "Checking…" : "Check Again"}
        </Button>
      </div>
    </ModalShell>
  );
}
