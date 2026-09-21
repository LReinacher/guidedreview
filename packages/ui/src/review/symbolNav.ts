/**
 * Go-to-definition inside the overlay.
 *
 * Two halves live here: reading the identifier a user command-clicked out of
 * rendered diff text, and finding declarations of it in the reviewed diff.
 * Repo-wide lookup is the host's job (`ReviewHost.findDefinition`); the diff
 * search is the floor every host gets, since a review very often lands on a
 * symbol the branch itself introduced.
 */

import {
  createDeclarationMatcher,
  isSymbolName,
  isTestPath,
  resolveLocalBinding,
  symbolKindRank,
  symbolLanguageForPath,
  type SymbolKind,
} from "@guided-review/core";
import type { DiffHunk, ParsedDiff } from "@guided-review/ui/review/types";
import { lineIdFor, sideForLine } from "./commentTypes";
import type { SymbolDefinition } from "./host";

/** Identifier characters, matching what JS, and near enough what other languages, allow. */
const IDENTIFIER = /[A-Za-z0-9_$]/;

/** Lines kept around the declaration line, as the preview body. */
export const SNIPPET_BEFORE = 2;
export const SNIPPET_AFTER = 40;

/** Most declarations we will show for one symbol. */
export const MAX_DEFINITIONS = 8;

export interface IdentifierAtOffset {
  name: string;
  /** Half-open `[start, end)` range of the identifier inside the line. */
  start: number;
  end: number;
}

/**
 * The identifier covering `offset` in `text`. A click lands *between* two
 * characters, so a caret resting right after a word still resolves to it —
 * the same forgiveness an editor gives.
 */
export function identifierAt(text: string, offset: number): IdentifierAtOffset | null {
  if (offset < 0 || offset > text.length) return null;

  let index = offset;
  if (!IDENTIFIER.test(text[index] ?? "")) {
    if (index === 0 || !IDENTIFIER.test(text[index - 1] ?? "")) return null;
    index -= 1;
  }

  let start = index;
  while (start > 0 && IDENTIFIER.test(text[start - 1]!)) start -= 1;
  let end = index + 1;
  while (end < text.length && IDENTIFIER.test(text[end]!)) end += 1;

  const name = text.slice(start, end);
  if (!isSymbolName(name)) return null;
  return { name, start, end };
}

/** Lines on the side a declaration would be read from — deletions are gone. */
function isVisibleSide(type: DiffHunk["lines"][number]["type"]): boolean {
  return type !== "del";
}

/**
 * The declaration with context either side, out of the hunk it was found in.
 * Deleted lines are skipped, so the snippet reads as the file will.
 */
function snippetFromHunk(
  hunk: DiffHunk,
  index: number,
): { snippet: string[]; snippetStartLine: number } {
  const visible = hunk.lines
    .map((line, i) => (isVisibleSide(line.type) ? i : -1))
    .filter((i) => i >= 0);
  const position = visible.indexOf(index);
  if (position === -1) {
    const line = hunk.lines[index]!;
    return { snippet: [line.content], snippetStartLine: line.newLine ?? line.oldLine ?? 1 };
  }

  const window = visible.slice(
    Math.max(0, position - SNIPPET_BEFORE),
    position + SNIPPET_AFTER + 1,
  );
  const first = hunk.lines[window[0]!]!;
  return {
    snippet: window.map((i) => hunk.lines[i]!.content),
    snippetStartLine: first.newLine ?? first.oldLine ?? 1,
  };
}

/**
 * The visible (new-side) lines of a hunk as a contiguous run, with the file
 * line and hunk index each one came from.
 */
function visibleRun(hunk: DiffHunk): { contents: string[]; numbers: number[]; indices: number[] } {
  const contents: string[] = [];
  const numbers: number[] = [];
  const indices: number[] = [];
  for (const [index, line] of hunk.lines.entries()) {
    if (!isVisibleSide(line.type)) continue;
    const number = line.newLine ?? line.oldLine;
    if (number == null) continue;
    contents.push(line.content);
    numbers.push(number);
    indices.push(index);
  }
  return { contents, numbers, indices };
}

/**
 * What the name is bound to in the file the click came from — a parameter, a
 * local, an import — read out of the hunk around it. Only the diff is
 * available here, so the scope is whatever the hunk shows; a host that can
 * read the whole file does better and its answer is merged in on top.
 */
function localDefinitionInDiff(
  diff: ParsedDiff,
  name: string,
  fromPath: string,
  fromLine: number,
): SymbolDefinition | null {
  const file = diff.files.find((entry) => entry.path === fromPath);
  if (!file || file.isBinaryOrElided) return null;
  const language = symbolLanguageForPath(file.path);

  for (const hunk of file.hunks) {
    const run = visibleRun(hunk);
    const firstLine = run.numbers[0];
    const lastLine = run.numbers[run.numbers.length - 1];
    if (firstLine == null || lastLine == null) continue;
    if (fromLine < firstLine || fromLine > lastLine) continue;

    const binding = resolveLocalBinding({
      lines: run.contents,
      firstLine,
      clickLine: fromLine,
      name,
      language,
    });
    if (!binding) return null;

    const position = run.numbers.indexOf(binding.line);
    if (position === -1) return null;
    const hunkIndex = run.indices[position]!;
    return {
      path: file.path,
      line: binding.line,
      kind: binding.kind,
      ...snippetFromHunk(hunk, hunkIndex),
      diffLineId: lineIdFor(hunk.id, hunkIndex, sideForLine(hunk.lines[hunkIndex]!.type)),
      hunkId: hunk.id,
    };
  }
  return null;
}

/**
 * Declarations of `name` among the changed files themselves, the one it is
 * bound to locally first. Only lines that survive in the new file are
 * considered: a declaration the branch deleted is not somewhere to send the
 * reader.
 */
export function findDefinitionsInDiff(
  diff: ParsedDiff,
  name: string,
  fromPath: string,
  fromLine?: number,
): SymbolDefinition[] {
  if (!isSymbolName(name)) return [];

  const local =
    fromLine && fromLine > 0 ? localDefinitionInDiff(diff, name, fromPath, fromLine) : null;

  const found: SymbolDefinition[] = [];
  const matchersByLanguage = new Map<string, (line: string) => SymbolKind | null>();

  for (const file of diff.files) {
    if (file.isBinaryOrElided) continue;
    const language = symbolLanguageForPath(file.path);
    let matches = matchersByLanguage.get(language);
    if (!matches) {
      matches = createDeclarationMatcher(name, language);
      matchersByLanguage.set(language, matches);
    }

    for (const hunk of file.hunks) {
      for (const [index, line] of hunk.lines.entries()) {
        if (!isVisibleSide(line.type)) continue;
        const kind = matches(line.content);
        if (!kind) continue;
        found.push({
          path: file.path,
          line: line.newLine ?? line.oldLine ?? 0,
          kind,
          ...snippetFromHunk(hunk, index),
          diffLineId: lineIdFor(hunk.id, index, sideForLine(line.type)),
          hunkId: hunk.id,
        });
      }
    }
  }

  // A name bound to a parameter or a local is lexical: same-named locals in
  // other files are noise, not candidates.
  const lexical = local?.kind === "parameter" || local?.kind === "variable";
  const others = found.filter((definition) => {
    if (local && definition.path === local.path && definition.line === local.line) return false;
    if (!lexical) return true;
    return (
      definition.path === fromPath ||
      (definition.kind !== "variable" && definition.kind !== "parameter")
    );
  });

  const ranked = rankDefinitions(others, fromPath);
  return local ? [local, ...ranked] : ranked;
}

/**
 * Same file, then same directory, then the declaration that reads strongest —
 * with test files last unless the click came from one.
 */
export function rankDefinitions(
  definitions: SymbolDefinition[],
  fromPath: string,
): SymbolDefinition[] {
  const fromDir = fromPath.slice(0, fromPath.lastIndexOf("/") + 1);
  const fromTest = isTestPath(fromPath);
  const testness = (definition: SymbolDefinition): number =>
    !fromTest && isTestPath(definition.path) ? 1 : 0;
  const score = (definition: SymbolDefinition): number => {
    if (definition.path === fromPath) return 0;
    if (fromDir && definition.path.startsWith(fromDir)) return 1;
    return 2;
  };

  return [...definitions].sort((a, b) => {
    const byTestness = testness(a) - testness(b);
    if (byTestness !== 0) return byTestness;
    const proximity = score(a) - score(b);
    if (proximity !== 0) return proximity;
    const kind = symbolKindRank(a.kind ?? "variable") - symbolKindRank(b.kind ?? "variable");
    if (kind !== 0) return kind;
    if (a.path !== b.path) return a.path.localeCompare(b.path);
    return a.line - b.line;
  });
}

/**
 * Host results plus diff results, one entry per file and line.
 *
 * Order is preserved rather than recomputed: each side already put its best
 * answer first — the host after resolving local scope against the whole file,
 * the diff after resolving it against the hunk — and re-ranking here would
 * shuffle a parameter back behind a same-named declaration elsewhere. Diff
 * entries merge their `diffLineId` in, which is what makes an in-review
 * declaration jumpable instead of only openable.
 */
export function mergeDefinitions(
  hostResults: SymbolDefinition[],
  diffResults: SymbolDefinition[],
): SymbolDefinition[] {
  const byLocation = new Map<string, SymbolDefinition>();
  for (const definition of [...hostResults, ...diffResults]) {
    const key = `${definition.path}:${definition.line}`;
    const existing = byLocation.get(key);
    byLocation.set(key, existing ? { ...existing, ...definition } : definition);
  }
  return [...byLocation.values()].slice(0, MAX_DEFINITIONS);
}
