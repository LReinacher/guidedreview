import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { imageMimeType, isImagePath } from "@guided-review/core";
import type { DiffFile } from "@guided-review/core";
import { GitError, runGit, runGitBuffer } from "./run";
import type { DiffScopeId, LocalReviewSnapshot } from "./localDiff";

/** Cap for any blob we read out of git or the worktree, image or text. */
export const MAX_BLOB_BYTES = 8 * 1024 * 1024;

/** Most context lines one gap-expansion request may return. */
export const MAX_CONTEXT_LINES = 500;

/** Which side of a file change to load for an image preview. */
export const FILE_PREVIEW_SIDES = ["old", "new"] as const;
export type FilePreviewSide = (typeof FILE_PREVIEW_SIDES)[number];

export function isFilePreviewSide(value: string): value is FilePreviewSide {
  return (FILE_PREVIEW_SIDES as readonly string[]).includes(value);
}

/**
 * Pull the commit SHA out of a `commit:<sha>` scope id.
 * Other scopes (`branch`, `unstaged`, …) are not commit-pinned, so return null.
 */
function commitShaFromScope(id: DiffScopeId): string | null {
  return id.startsWith("commit:") ? id.slice("commit:".length) : null;
}

/**
 * Resolve `filePath` under `repoRoot` and reject path-traversal / absolute /
 * NUL-laden inputs. Callers must not read arbitrary paths off the API.
 */
function resolveWorktreePath(repoRoot: string, filePath: string): string | null {
  if (!filePath || filePath.startsWith("/") || filePath.includes("\0")) return null;
  const root = path.resolve(repoRoot);
  const resolved = path.resolve(repoRoot, filePath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

/**
 * `git show <spec>` → bytes, or null when the object is missing.
 * Non-git failures still propagate so callers can surface them.
 */
async function gitShow(repoRoot: string, spec: string): Promise<Buffer | null> {
  try {
    return await runGitBuffer(["show", spec], repoRoot);
  } catch (error) {
    if (error instanceof GitError) return null;
    throw error;
  }
}

/**
 * Read a file from the live worktree (unstaged / uncommitted new side).
 * Caps at MAX_BLOB_BYTES so a huge binary can't blow the preview endpoint.
 */
async function readWorktree(repoRoot: string, filePath: string): Promise<Buffer | null> {
  const resolved = resolveWorktreePath(repoRoot, filePath);
  if (!resolved) return null;
  try {
    const info = await stat(resolved);
    if (!info.isFile()) return null;
    if (info.size > MAX_BLOB_BYTES) return null;
    return await readFile(resolved);
  } catch {
    return null;
  }
}

/**
 * Old/new blob for an image in the current review snapshot.
 * Only files present in the parsed diff are readable.
 */
export async function readReviewImage(
  snapshot: LocalReviewSnapshot,
  filePath: string,
  side: FilePreviewSide,
): Promise<{ bytes: Buffer; mime: string } | null> {
  const file = snapshot.diff.files.find((entry) => entry.path === filePath);
  if (!file || !isImagePath(file.path)) return null;

  const bytes = side === "old" ? await readOld(snapshot, file) : await readNew(snapshot, file);
  if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_BLOB_BYTES) return null;

  const mime = imageMimeType(file.path);
  if (!mime) return null;
  return { bytes, mime };
}

/**
 * Pre-image for `file` under the snapshot's selected scope.
 * Added files have no old blob; renames read via `previousPath`.
 */
async function readOld(snapshot: LocalReviewSnapshot, file: DiffFile): Promise<Buffer | null> {
  if (file.status === "added") return null;
  const blobPath = file.previousPath ?? file.path;
  const { repo, selectedScope } = snapshot;
  const sha = commitShaFromScope(selectedScope);
  if (sha) return gitShow(repo.repoRoot, `${sha}^:${blobPath}`);
  if (selectedScope === "branch") return gitShow(repo.repoRoot, `${repo.mergeBase}:${blobPath}`);
  if (selectedScope === "unstaged") return gitShow(repo.repoRoot, `:${blobPath}`);
  return gitShow(repo.repoRoot, `HEAD:${blobPath}`);
}

/**
 * Post-image for `file` under the snapshot's selected scope.
 * Removed files have no new blob; unstaged/uncommitted may read the worktree.
 */
async function readNew(snapshot: LocalReviewSnapshot, file: DiffFile): Promise<Buffer | null> {
  if (file.status === "removed") return null;
  const blobPath = file.path;
  const { repo, selectedScope } = snapshot;
  const sha = commitShaFromScope(selectedScope);
  if (sha) return gitShow(repo.repoRoot, `${sha}:${blobPath}`);
  if (selectedScope === "branch") return gitShow(repo.repoRoot, `HEAD:${blobPath}`);
  if (selectedScope === "unstaged") return readWorktree(repo.repoRoot, blobPath);
  if (repo.staged) return gitShow(repo.repoRoot, `:${blobPath}`);
  return readWorktree(repo.repoRoot, blobPath);
}

/** Most lines the file viewer or a snippet read will return from one file. */
export const MAX_SOURCE_LINES = 20000;

/**
 * Text of a file in the worktree, as lines, for symbol lookup and the file
 * viewer. Unlike the diff-scoped readers above this can reach any file git
 * tracks — following a symbol out of the diff is the whole point — so it is
 * fenced by the same path-traversal guard plus a tracked-file check.
 */
export async function readWorktreeTextFile(
  repoRoot: string,
  filePath: string,
  maxLines: number = MAX_SOURCE_LINES,
): Promise<{ lines: string[]; truncated: boolean } | null> {
  const bytes = await readWorktree(repoRoot, filePath);
  if (!bytes || looksBinary(bytes)) return null;

  const lines = bytes.toString("utf8").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const truncated = lines.length > maxLines;
  return {
    lines: (truncated ? lines.slice(0, maxLines) : lines).map((line) =>
      line.endsWith("\r") ? line.slice(0, -1) : line,
    ),
    truncated,
  };
}

/**
 * Is `filePath` a file git knows about (tracked, or untracked but not ignored)?
 * The file viewer serves only these, so an ignored `.env` sitting next to the
 * code never becomes readable over the local HTTP server.
 */
export async function isReadablePath(repoRoot: string, filePath: string): Promise<boolean> {
  if (!resolveWorktreePath(repoRoot, filePath)) return false;
  try {
    const listed = await runGit(
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", filePath],
      repoRoot,
    );
    return listed.split("\0").some((entry) => entry === filePath);
  } catch {
    return false;
  }
}

/** Heuristic: a NUL byte near the start means this is not text worth rendering. */
function looksBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, 8000).includes(0);
}

/**
 * Every text line of one side of a file in the current snapshot, or null when
 * there is nothing readable there. Only files in the parsed diff are readable,
 * so the API can never be pointed at an arbitrary path.
 */
async function readTextLines(
  snapshot: LocalReviewSnapshot,
  filePath: string,
  side: FilePreviewSide,
): Promise<string[] | null> {
  const file = snapshot.diff.files.find((entry) => entry.path === filePath);
  if (!file || file.isBinaryOrElided || isImagePath(file.path)) return null;

  const bytes = side === "old" ? await readOld(snapshot, file) : await readNew(snapshot, file);
  if (!bytes || bytes.byteLength > MAX_BLOB_BYTES || looksBinary(bytes)) return null;

  const lines = bytes.toString("utf8").split("\n");
  // A trailing newline leaves a final empty element that is not a real line.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/**
 * Text lines `[startLine, endLine]` (1-indexed, inclusive) from one side of a
 * file in the current snapshot — the context the overlay reveals when the user
 * expands a collapsed gap or extends a diff past its last hunk. The range is
 * capped so one click cannot pull a whole monorepo file across the wire.
 */
export async function readReviewFileLines(
  snapshot: LocalReviewSnapshot,
  filePath: string,
  side: FilePreviewSide,
  startLine: number,
  endLine: number,
): Promise<string[] | null> {
  if (startLine < 1 || endLine < startLine) return null;
  if (endLine - startLine + 1 > MAX_CONTEXT_LINES) return null;

  const lines = await readTextLines(snapshot, filePath, side);
  if (!lines) return null;
  return lines.slice(startLine - 1, Math.min(endLine, lines.length));
}

/**
 * How many lines one side of a file has. The overlay asks before offering to
 * extend a diff downwards: the patch ends at its last hunk and says nothing
 * about whether any file is left under it.
 */
export async function readReviewFileLineCount(
  snapshot: LocalReviewSnapshot,
  filePath: string,
  side: FilePreviewSide,
): Promise<number | null> {
  const lines = await readTextLines(snapshot, filePath, side);
  return lines ? lines.length : null;
}
