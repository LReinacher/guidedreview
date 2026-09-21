import { describe, expect, it } from "vitest";
import { resolveLocalBinding } from "./localScope";

/** The shape that made repo-wide search look ridiculous: a parameter in scope. */
const USE_CASE = [
  "import { Injectable } from '@nestjs/common';",
  "import { TournamentNotFoundError } from '../../domain/errors/tournament-not-found';",
  "",
  "@Injectable()",
  "export class ResolveTournamentMerchantUseCase {",
  "  constructor(private readonly eventCollectionRepo: IEventCollectionReadRepository) {}",
  "",
  "  async execute(tournamentId: string): Promise<string> {",
  "    const merchantId = await this.eventCollectionRepo.findTournamentMerchantId(tournamentId);",
  "    if (!merchantId) throw new TournamentNotFoundError(tournamentId);",
  "    return merchantId;",
  "  }",
  "}",
];

function resolve(lines: string[], clickLine: number, name: string, language = "js" as const) {
  return resolveLocalBinding({ lines, firstLine: 1, clickLine, name, language });
}

describe("resolveLocalBinding", () => {
  it("resolves a use to the parameter it came in on", () => {
    expect(resolve(USE_CASE, 9, "tournamentId")).toEqual({ line: 8, kind: "parameter" });
  });

  it("resolves a constructor parameter property", () => {
    expect(resolve(USE_CASE, 9, "eventCollectionRepo")).toEqual({ line: 6, kind: "parameter" });
  });

  it("resolves a local const above the use", () => {
    expect(resolve(USE_CASE, 11, "merchantId")).toEqual({ line: 9, kind: "variable" });
  });

  it("resolves an imported name to the import, with the module it came from", () => {
    expect(resolve(USE_CASE, 10, "TournamentNotFoundError")).toEqual({
      line: 2,
      kind: "import",
      moduleSpecifier: "../../domain/errors/tournament-not-found",
    });
  });

  it("does not mistake a call argument for a parameter", () => {
    // `merchantId` is used as an argument on line 10; its binding is the const,
    // never the call it appears in.
    expect(resolve(USE_CASE, 10, "merchantId")?.line).toBe(9);
  });

  it("finds nothing for a name that is not bound in this file", () => {
    expect(resolve(USE_CASE, 9, "somethingElse")).toBeNull();
  });

  it("ignores a binding in a sibling block", () => {
    const lines = [
      "function outer() {",
      "  if (a) {",
      "    const value = 1;",
      "  }",
      "  return value;",
      "}",
    ];
    expect(resolve(lines, 5, "value")).toBeNull();
  });

  it("reads a multi-line parameter list", () => {
    const lines = [
      "  async execute(",
      "    tournamentId: string,",
      "    actorId: string,",
      "  ): Promise<string> {",
      "    return this.repo.find(tournamentId);",
      "  }",
    ];
    expect(resolve(lines, 5, "tournamentId")).toEqual({ line: 2, kind: "parameter" });
  });

  it("reads an arrow function's parameters", () => {
    const lines = [
      "const fetchMessages = async (eventCollectionId: string) => {",
      "  return request(eventCollectionId);",
      "};",
    ];
    expect(resolve(lines, 2, "eventCollectionId")).toEqual({ line: 1, kind: "parameter" });
  });

  it("reads destructured and loop bindings", () => {
    const lines = [
      "function run(input) {",
      "  const { tournamentId } = input;",
      "  for (const entry of input.entries) {",
      "    use(tournamentId, entry);",
      "  }",
      "}",
    ];
    expect(resolve(lines, 4, "tournamentId")).toEqual({ line: 2, kind: "variable" });
    expect(resolve(lines, 4, "entry")).toEqual({ line: 3, kind: "variable" });
  });

  it("works on a slice of a file, reporting real file lines", () => {
    const lines = ["  async execute(tournamentId: string) {", "    return find(tournamentId);"];
    expect(
      resolveLocalBinding({
        lines,
        firstLine: 120,
        clickLine: 121,
        name: "tournamentId",
        language: "js",
      }),
    ).toEqual({ line: 120, kind: "parameter" });
  });

  it("resolves Python parameters, loops and imports", () => {
    const lines = [
      "from app.errors import TournamentNotFound",
      "",
      "def resolve(tournament_id):",
      "    for entry in entries:",
      "        raise TournamentNotFound(tournament_id, entry)",
    ];
    expect(resolve(lines, 5, "tournament_id", "python")).toEqual({ line: 3, kind: "parameter" });
    expect(resolve(lines, 5, "entry", "python")).toEqual({ line: 4, kind: "variable" });
    expect(resolve(lines, 5, "TournamentNotFound", "python")).toEqual({
      line: 1,
      kind: "import",
      moduleSpecifier: "app.errors",
    });
  });
});

describe("multi-line imports", () => {
  const lines = [
    "import {",
    "  createDeclarationMatcher,",
    "  isSymbolName,",
    "} from '@guided-review/core';",
    "",
    "export function search(symbol: string) {",
    "  if (!isSymbolName(symbol)) return [];",
    "  return createDeclarationMatcher(symbol, 'js');",
    "}",
  ];

  it("resolves a name imported across several lines", () => {
    expect(
      resolveLocalBinding({
        lines,
        firstLine: 1,
        clickLine: 7,
        name: "isSymbolName",
        language: "js",
      }),
    ).toEqual({ line: 3, kind: "import", moduleSpecifier: "@guided-review/core" });
  });

  it("resolves a python parenthesised import", () => {
    const py = [
      "from app.errors import (",
      "    TournamentNotFound,",
      ")",
      "",
      "def resolve(id):",
      "    raise TournamentNotFound(id)",
    ];
    expect(
      resolveLocalBinding({
        lines: py,
        firstLine: 1,
        clickLine: 6,
        name: "TournamentNotFound",
        language: "python",
      }),
    ).toEqual({ line: 2, kind: "import", moduleSpecifier: "app.errors" });
  });
});
