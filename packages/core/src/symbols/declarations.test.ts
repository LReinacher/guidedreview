import { describe, expect, it } from "vitest";
import {
  createDeclarationMatcher,
  declarationKind,
  isSymbolName,
  symbolLanguageForPath,
} from "./declarations";

describe("declarationKind", () => {
  it.each([
    ["js", "export function buildPlan(diff: ParsedDiff) {", "buildPlan", "function"],
    ["js", "export default async function buildPlan() {", "buildPlan", "function"],
    ["js", "export abstract class ReviewHost {", "ReviewHost", "class"],
    ["js", "export interface ReviewHost {", "ReviewHost", "type"],
    ["js", "type SymbolKind = 'a' | 'b';", "SymbolKind", "type"],
    ["js", "  export const buildPlan = (x) => x;", "buildPlan", "variable"],
    ["js", "  private async buildPlan(diff: Diff): Promise<void> {", "buildPlan", "method"],
    ["js", "  buildPlan: async (diff) => {", "buildPlan", "function"],
    ["python", "  async def build_plan(self, diff):", "build_plan", "function"],
    ["python", "class ReviewHost(Base):", "ReviewHost", "class"],
    ["go", "func BuildPlan(diff string) error {", "BuildPlan", "function"],
    ["go", "func (h *Host) BuildPlan() error {", "BuildPlan", "method"],
    ["go", "type ReviewHost struct {", "ReviewHost", "type"],
    [
      "rust",
      "pub(crate) async fn build_plan(diff: &str) -> Result<()> {",
      "build_plan",
      "function",
    ],
    ["rust", "pub struct ReviewHost {", "ReviewHost", "class"],
    ["java", "public final class ReviewHost implements Host {", "ReviewHost", "class"],
    ["java", "  public static Plan buildPlan(String diff) {", "buildPlan", "method"],
    ["kotlin", "  private suspend fun buildPlan(diff: String) {", "buildPlan", "function"],
    ["csharp", "  public async Task<Plan> BuildPlan(string diff) {", "BuildPlan", "method"],
    ["swift", "  public func buildPlan(diff: String) -> Plan {", "buildPlan", "function"],
    ["c", "static struct plan *build_plan(const char *diff) {", "build_plan", "function"],
    ["c", "#define MAX_BLOB 8", "MAX_BLOB", "macro"],
    ["ruby", "  def self.build_plan(diff)", "build_plan", "function"],
    ["php", "  public function buildPlan($diff) {", "buildPlan", "function"],
    ["generic", "fn build_plan(diff) {", "build_plan", "function"],
  ] as const)("reads a %s declaration of %s", (language, line, name, kind) => {
    expect(declarationKind(line, name, language)).toBe(kind);
  });

  it.each([
    ["js", "  const plan = buildPlan(diff);", "buildPlan"],
    ["js", "  return buildPlan(diff);", "buildPlan"],
    ["js", "import { buildPlan } from './plan';", "buildPlan"],
    ["js", "  await host.buildPlan(diff);", "buildPlan"],
    ["python", "    plan = build_plan(diff)", "build_plan"],
    ["go", "  plan := BuildPlan(diff)", "BuildPlan"],
    ["java", "    return buildPlan(diff);", "buildPlan"],
    ["c", "  return build_plan(diff);", "build_plan"],
    ["c", "  build_plan(diff);", "build_plan"],
  ] as const)("does not read a %s use of %s as a declaration", (language, line, name) => {
    expect(declarationKind(line, name, language)).toBeNull();
  });

  it("only matches the whole identifier", () => {
    const match = createDeclarationMatcher("build", "js");
    expect(match("export function buildPlan() {")).toBeNull();
    expect(match("export function build() {")).toBe("function");
  });
});

describe("symbolLanguageForPath", () => {
  it.each([
    ["src/review/host.tsx", "js"],
    ["main.go", "go"],
    ["lib/plan.rb", "ruby"],
    ["Makefile", "generic"],
    ["notes.md", "generic"],
  ] as const)("maps %s", (path, language) => {
    expect(symbolLanguageForPath(path)).toBe(language);
  });
});

describe("isSymbolName", () => {
  it("accepts identifiers and rejects anything grep should not see", () => {
    expect(isSymbolName("buildPlan")).toBe(true);
    expect(isSymbolName("_private$1")).toBe(true);
    expect(isSymbolName("1plan")).toBe(false);
    expect(isSymbolName("build plan")).toBe(false);
    expect(isSymbolName("build-plan")).toBe(false);
    expect(isSymbolName("")).toBe(false);
  });
});
