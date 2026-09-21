import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  readReviewSession,
  sessionFileName,
  sessionsDir,
  writeReviewSession,
} from "./sessionStore";

async function gitDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "gr-sessions-"));
}

describe("review session store", () => {
  it("round-trips a review and answers null for keys it has never seen", async () => {
    const dir = await gitDir();
    const key = "repo:main:feat:branch";
    const state = { plan: { units: [{ id: "u1" }] }, draftComments: [{ id: "d1" }] };

    expect(await readReviewSession(dir, key)).toBeNull();
    await writeReviewSession(dir, key, state);
    expect(await readReviewSession(dir, key)).toEqual(state);

    // A different scope is a different review.
    expect(await readReviewSession(dir, "repo:main:feat:uncommitted")).toBeNull();
  });

  it("ignores a session file that is not readable JSON of this version", async () => {
    const dir = await gitDir();
    const key = "repo:main:feat:branch";
    await writeReviewSession(dir, key, { plan: null });
    const file = path.join(sessionsDir(dir), sessionFileName(key));

    await writeFile(file, "{ truncated");
    expect(await readReviewSession(dir, key)).toBeNull();

    await writeFile(file, JSON.stringify({ version: 999, state: { plan: null } }));
    expect(await readReviewSession(dir, key)).toBeNull();
  });

  it("keeps browser-supplied keys inside the sessions directory", async () => {
    const dir = await gitDir();
    await writeReviewSession(dir, "../../../etc/passwd", { plan: null });

    const written = await readdir(sessionsDir(dir));
    expect(written).toHaveLength(1);
    expect(written[0]).not.toContain("/");
    expect(await readReviewSession(dir, "../../../etc/passwd")).toEqual({ plan: null });
  });
});
