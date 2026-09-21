import { describe, expect, it } from "vitest";
import type { DiffFile, ParsedDiff } from "@guided-review/ui/review/types";
import { findDefinitionsInDiff, identifierAt, mergeDefinitions } from "./symbolNav";
import type { SymbolDefinition } from "./host";

function diffFixture(files: DiffFile[]): ParsedDiff {
  return { files } as ParsedDiff;
}

const planFile: DiffFile = {
  path: "src/review/plan.ts",
  status: "modified",
  isBinaryOrElided: false,
  hunks: [
    {
      id: "src/review/plan.ts#0",
      header: "@@ -8,3 +8,5 @@",
      oldStart: 8,
      oldLines: 3,
      newStart: 8,
      newLines: 5,
      lines: [
        { type: "context", content: "import { chunk } from './chunk';", oldLine: 8, newLine: 8 },
        { type: "del", content: "export function buildPlan(diff) {}", oldLine: 9 },
        { type: "add", content: "export function buildPlan(diff: string) {", newLine: 9 },
        { type: "add", content: "  return chunk(diff);", newLine: 10 },
        { type: "context", content: "}", oldLine: 10, newLine: 11 },
      ],
    },
  ],
};

const callerFile: DiffFile = {
  path: "src/caller.ts",
  status: "modified",
  isBinaryOrElided: false,
  hunks: [
    {
      id: "src/caller.ts#0",
      header: "@@ -1,2 +1,2 @@",
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 2,
      lines: [{ type: "add", content: "const plan = buildPlan(diff);", newLine: 1 }],
    },
  ],
};

describe("identifierAt", () => {
  it.each([
    ["const plan = buildPlan(diff);", 15, "buildPlan"],
    // A caret resting just past the word still resolves to it.
    ["const plan = buildPlan(diff);", 22, "buildPlan"],
    ["const plan = buildPlan(diff);", 13, "buildPlan"],
    ["host.findDefinition(x)", 8, "findDefinition"],
  ])("reads %s at offset %i", (text, offset, name) => {
    expect(identifierAt(text, offset)?.name).toBe(name);
  });

  it("returns the identifier's range", () => {
    expect(identifierAt("const plan = buildPlan(diff);", 15)).toEqual({
      name: "buildPlan",
      start: 13,
      end: 22,
    });
  });

  it.each([
    ["  return 42;", 9],
    ["const a = 1;", 11],
    ["", 0],
  ])("finds nothing in %s at offset %i", (text, offset) => {
    expect(identifierAt(text, offset)).toBeNull();
  });
});

describe("findDefinitionsInDiff", () => {
  it("finds a declaration the branch added, and ignores its call sites", () => {
    const found = findDefinitionsInDiff(
      diffFixture([callerFile, planFile]),
      "buildPlan",
      "src/caller.ts",
    );

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      path: "src/review/plan.ts",
      line: 9,
      kind: "function",
      diffLineId: "src/review/plan.ts#0:2:RIGHT",
      // Two lines of lead-in, and the deleted line between them is skipped.
      snippetStartLine: 8,
    });
    expect(found[0]!.snippet).toEqual([
      "import { chunk } from './chunk';",
      "export function buildPlan(diff: string) {",
      "  return chunk(diff);",
      "}",
    ]);
  });

  it("resolves a use to the parameter it came in on, ahead of anything else", () => {
    const useCase: DiffFile = {
      path: "src/use-cases/resolve-merchant.use-case.ts",
      status: "added",
      isBinaryOrElided: false,
      hunks: [
        {
          id: "src/use-cases/resolve-merchant.use-case.ts#0",
          header: "@@ -0,0 +1,4 @@",
          oldStart: 0,
          oldLines: 0,
          newStart: 15,
          newLines: 4,
          lines: [
            { type: "add", content: "  async execute(tournamentId: string) {", newLine: 15 },
            {
              type: "add",
              content: "    const id = await this.repo.find(tournamentId);",
              newLine: 16,
            },
            { type: "add", content: "    return id;", newLine: 17 },
            { type: "add", content: "  }", newLine: 18 },
          ],
        },
      ],
    };
    // A same-named local in an e2e spec: the kind of hit that used to win.
    const spec: DiffFile = {
      path: "test/e2e/tournament.e2e-spec.ts",
      status: "added",
      isBinaryOrElided: false,
      hunks: [
        {
          id: "test/e2e/tournament.e2e-spec.ts#0",
          header: "@@ -0,0 +1,1 @@",
          oldStart: 0,
          oldLines: 0,
          newStart: 26,
          newLines: 1,
          lines: [{ type: "add", content: "  let tournamentId: string;", newLine: 26 }],
        },
      ],
    };

    const found = findDefinitionsInDiff(
      diffFixture([useCase, spec]),
      "tournamentId",
      useCase.path,
      16,
    );

    expect(found[0]).toMatchObject({ path: useCase.path, line: 15, kind: "parameter" });
    // The unrelated spec local is dropped, not merely ranked below.
    expect(found.map((definition) => definition.path)).not.toContain(spec.path);
  });

  it("ignores a declaration that only exists on the deleted side", () => {
    const removed: DiffFile = {
      ...planFile,
      hunks: [{ ...planFile.hunks[0]!, lines: [planFile.hunks[0]!.lines[1]!] }],
    };

    expect(findDefinitionsInDiff(diffFixture([removed]), "buildPlan", "src/caller.ts")).toEqual([]);
  });
});

describe("mergeDefinitions", () => {
  it("keeps the diff's jump target when the host reports the same location", () => {
    const fromHost: SymbolDefinition = {
      path: "src/review/plan.ts",
      line: 9,
      kind: "function",
      snippet: ["export function buildPlan(diff: string) {"],
      snippetStartLine: 9,
    };
    const fromDiff: SymbolDefinition = { ...fromHost, diffLineId: "src/review/plan.ts#0:2:RIGHT" };

    const merged = mergeDefinitions([fromHost], [fromDiff]);

    expect(merged).toHaveLength(1);
    expect(merged[0]!.diffLineId).toBe("src/review/plan.ts#0:2:RIGHT");
  });
});
