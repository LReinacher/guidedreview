import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { findSymbolDefinitions } from "./symbolSearch";

const execFileAsync = promisify(execFile);

/**
 * One repo shared by the whole suite: the lookup is read-only, and `git init`
 * per case is the slow part.
 */
let repoRoot: string;

async function git(args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: repoRoot });
}

beforeAll(async () => {
  const dir = await mkdir(path.join(os.tmpdir(), `gr-symbols-${Date.now()}-${Math.random()}`), {
    recursive: true,
  });
  repoRoot = dir!;
  await execFileAsync("git", ["init", "-b", "main"], { cwd: repoRoot });
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Test"]);

  await mkdir(path.join(repoRoot, "src/review"), { recursive: true });
  await writeFile(
    path.join(repoRoot, "src/review/plan.ts"),
    [
      "import { chunk } from '../chunk';",
      "",
      "export function buildPlan(diff: string): string[] {",
      "  return chunk(diff);",
      "}",
      "",
      "export class PlanBuilder {",
      "  build(diff: string) {",
      "    return buildPlan(diff);",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(repoRoot, "src/chunk.ts"),
    [
      "export function chunk(diff: string): string[] {",
      "  return diff.split('\\n');",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(repoRoot, "src/caller.ts"),
    [
      "import { buildPlan } from './review/plan';",
      "",
      "export const run = () => buildPlan('diff');",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(repoRoot, "other.py"),
    ["def build_plan(diff):", "    return diff", ""].join("\n"),
  );
  await mkdir(path.join(repoRoot, "src/use-cases"), { recursive: true });
  await writeFile(
    path.join(repoRoot, "src/use-cases/resolve-merchant.use-case.ts"),
    [
      "import { chunk } from '../chunk';",
      "",
      "export class ResolveMerchantUseCase {",
      "  async execute(tournamentId: string): Promise<string> {",
      "    const merchantId = await this.repo.findMerchantId(tournamentId);",
      "    return chunk(merchantId)[0];",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  await mkdir(path.join(repoRoot, "test/e2e"), { recursive: true });
  await writeFile(
    path.join(repoRoot, "test/e2e/tournament.e2e-spec.ts"),
    [
      "describe('tournaments', () => {",
      "  let tournamentId: string;",
      "  const chunk = (value: string) => [value];",
      "});",
      "",
    ].join("\n"),
  );
  await git(["add", "."]);
  await git(["commit", "-m", "initial"]);
});

describe("findSymbolDefinitions", () => {
  it("finds the declaration and skips imports and call sites", async () => {
    const found = await findSymbolDefinitions(repoRoot, "buildPlan", "src/caller.ts");

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      path: "src/review/plan.ts",
      line: 3,
      kind: "function",
      // Clamped to the top of the file rather than reaching past line 1.
      snippetStartLine: 1,
    });
    // The snippet runs past the declaration so the card has something to scroll.
    expect(found[0]!.snippet[2]).toContain("export function buildPlan");
    expect(found[0]!.snippet).toContain("export class PlanBuilder {");
  });

  it("puts a declaration in the clicked file ahead of one elsewhere", async () => {
    const found = await findSymbolDefinitions(repoRoot, "chunk", "src/chunk.ts");

    expect(found[0]?.path).toBe("src/chunk.ts");
  });

  it("only searches files of the clicked file's language", async () => {
    const fromTypeScript = await findSymbolDefinitions(repoRoot, "build_plan", "src/caller.ts");
    const fromPython = await findSymbolDefinitions(repoRoot, "build_plan", "other.py");

    expect(fromTypeScript).toEqual([]);
    expect(fromPython.map((definition) => definition.path)).toEqual(["other.py"]);
  });

  it("finds a declaration in a file that is not committed yet", async () => {
    await writeFile(
      path.join(repoRoot, "src/fresh.ts"),
      ["export const freshSymbol = 42;", ""].join("\n"),
    );

    const found = await findSymbolDefinitions(repoRoot, "freshSymbol", "src/caller.ts");

    expect(found.map((definition) => definition.path)).toEqual(["src/fresh.ts"]);
  });

  it("resolves a use to the parameter it came in on, not a same-named local elsewhere", async () => {
    const useCase = "src/use-cases/resolve-merchant.use-case.ts";
    const found = await findSymbolDefinitions(repoRoot, "tournamentId", useCase, 5);

    expect(found[0]).toMatchObject({ path: useCase, line: 4, kind: "parameter" });
    expect(found.map((definition) => definition.path)).not.toContain(
      "test/e2e/tournament.e2e-spec.ts",
    );
  });

  it("follows an import to the declaration in the module it names", async () => {
    const useCase = "src/use-cases/resolve-merchant.use-case.ts";
    const found = await findSymbolDefinitions(repoRoot, "chunk", useCase, 6);

    expect(found[0]).toMatchObject({ path: "src/chunk.ts", line: 1, kind: "function" });
    // The import line stays on the list, so it is clear where the name entered.
    expect(found[1]).toMatchObject({ path: useCase, line: 1, kind: "import" });
  });

  it("puts a test file's declaration last when the click came from source", async () => {
    const found = await findSymbolDefinitions(repoRoot, "chunk", "src/caller.ts");

    expect(found.map((definition) => definition.path)).toEqual([
      "src/chunk.ts",
      "test/e2e/tournament.e2e-spec.ts",
    ]);
  });

  it("refuses anything that is not an identifier", async () => {
    expect(await findSymbolDefinitions(repoRoot, "not a symbol", "src/caller.ts")).toEqual([]);
  });
});
