/**
 * Durable review sessions, so a crashed or closed CLI can be restarted and
 * pick the same review back up: the generated structure, where the user was,
 * and every comment they had written but not yet posted.
 *
 * State lives under the repo's git dir. It travels with the worktree, git
 * already ignores it, and deleting the clone takes it with it.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/** Bumped when the persisted shape stops being readable by this version. */
export const SESSION_FORMAT_VERSION = 1;

/** Keep the working set small; an abandoned branch should not linger forever. */
const MAX_SESSIONS = 20;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface StoredReviewSession {
  version: number;
  key: string;
  savedAt: string;
  state: unknown;
}

export function sessionsDir(gitDir: string): string {
  return path.join(gitDir, "guided-review", "sessions");
}

/**
 * Session keys come from the browser, so never let one address a path. The
 * readable slug is cosmetic (it makes the directory browsable); the hash is
 * what actually identifies the session.
 */
export function sessionFileName(key: string): string {
  const slug = key
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 12);
  return `${slug ? `${slug}-` : ""}${hash}.json`;
}

function sessionPath(gitDir: string, key: string): string {
  return path.join(sessionsDir(gitDir), sessionFileName(key));
}

export async function readReviewSession(gitDir: string, key: string): Promise<unknown | null> {
  let raw: string;
  try {
    raw = await readFile(sessionPath(gitDir, key), "utf8");
  } catch {
    return null;
  }
  let parsed: StoredReviewSession;
  try {
    parsed = JSON.parse(raw) as StoredReviewSession;
  } catch {
    // A half-written or hand-edited file is not worth failing a review over.
    return null;
  }
  if (parsed?.version !== SESSION_FORMAT_VERSION) return null;
  return parsed.state ?? null;
}

/**
 * Write via a temp file + rename so a crash mid-write cannot leave a truncated
 * session behind — the whole point of this store is surviving a crash.
 */
export async function writeReviewSession(
  gitDir: string,
  key: string,
  state: unknown,
): Promise<void> {
  const dir = sessionsDir(gitDir);
  await mkdir(dir, { recursive: true });
  const payload: StoredReviewSession = {
    version: SESSION_FORMAT_VERSION,
    key,
    savedAt: new Date().toISOString(),
    state,
  };
  const target = sessionPath(gitDir, key);
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  await rename(temp, target);
  await pruneSessions(dir).catch(() => {
    // Housekeeping only — never fail a save because cleanup failed.
  });
}

export async function deleteReviewSession(gitDir: string, key: string): Promise<void> {
  await rm(sessionPath(gitDir, key), { force: true });
}

/** Drop sessions older than the retention window, then the oldest over the cap. */
async function pruneSessions(dir: string): Promise<void> {
  const names = (await readdir(dir)).filter((name) => name.endsWith(".json"));
  const now = Date.now();
  const entries: { file: string; mtimeMs: number }[] = [];

  for (const name of names) {
    const file = path.join(dir, name);
    const info = await stat(file).catch(() => null);
    if (!info) continue;
    if (now - info.mtimeMs > MAX_AGE_MS) {
      await rm(file, { force: true });
      continue;
    }
    entries.push({ file, mtimeMs: info.mtimeMs });
  }

  if (entries.length <= MAX_SESSIONS) return;
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const entry of entries.slice(MAX_SESSIONS)) {
    await rm(entry.file, { force: true });
  }
}
