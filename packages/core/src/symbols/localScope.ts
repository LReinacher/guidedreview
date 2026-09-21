/**
 * The declaration a symbol resolves to *in the file you clicked in*.
 *
 * This runs before any repo-wide search, because it answers the question a
 * reader actually asked. Clicking `tournamentId` inside a method body means
 * the parameter two lines up — not the three same-named locals a grep finds in
 * unrelated e2e specs. Same for a `const` in the enclosing block, a `for`
 * binding, or an import, which is the hop to where the real definition lives.
 *
 * Still heuristics, not a parser: it walks up from the clicked line, skips
 * anything indented deeper (a sibling block cannot be in scope), and matches
 * the shapes a binding takes. Being wrong looks like offering nothing, which
 * falls back to the repo-wide search.
 */

import { createDeclarationMatcher, type SymbolKind, type SymbolLanguage } from "./declarations";

/** How far above the click a multi-line parameter list is still considered. */
const MAX_SIGNATURE_LOOKBACK = 40;

/** How far above the click we look for a binding at all. */
const MAX_SCAN_LINES = 4000;

export interface LocalBindingRequest {
  /** Source lines. May be a contiguous slice of the file, not the whole thing. */
  lines: string[];
  /** 1-indexed file line of `lines[0]`. */
  firstLine: number;
  /** 1-indexed file line the click landed on. */
  clickLine: number;
  name: string;
  language: SymbolLanguage;
}

export interface LocalBinding {
  /** 1-indexed file line the binding is on. */
  line: number;
  kind: SymbolKind;
  /** For `kind: "import"`, the module the name is imported from. */
  moduleSpecifier?: string;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wordAt(name: string): RegExp {
  const escaped = escapeForRegExp(name);
  return new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`);
}

function indentOf(line: string): number {
  return (/^[ \t]*/.exec(line)?.[0] ?? "").replace(/\t/g, "  ").length;
}

/** Quotes and template literals hold parens that are not code. */
function stripStrings(line: string): string {
  return line.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, (match) => " ".repeat(match.length));
}

/**
 * Index of the line whose `(` is still open at `index`, or null when `index`
 * is not inside a parameter list.
 */
function openParenLine(lines: string[], index: number, upTo?: number): number | null {
  let depth = 0;
  for (let i = index; i >= 0 && index - i <= MAX_SIGNATURE_LOOKBACK; i -= 1) {
    const line = stripStrings(lines[i]!);
    const from = i === index && upTo != null ? upTo - 1 : line.length - 1;
    for (let c = Math.min(from, line.length - 1); c >= 0; c -= 1) {
      const char = line[c];
      if (char === ")") depth += 1;
      else if (char === "(") {
        if (depth === 0) return i;
        depth -= 1;
      }
    }
  }
  return null;
}

/**
 * Does the parameter list opening at `openIndex` belong to a function
 * definition rather than a call? Look at what follows its closing paren: a
 * definition opens a body (`{`) or an arrow (`=>`); a call is followed by
 * anything else — `;`, `)`, `.then(`.
 */
function isDefinitionParamList(lines: string[], openIndex: number): boolean {
  let depth = 0;
  for (let i = openIndex; i < lines.length && i - openIndex <= MAX_SIGNATURE_LOOKBACK; i += 1) {
    const line = stripStrings(lines[i]!);
    for (let c = i === openIndex ? line.indexOf("(") : 0; c >= 0 && c < line.length; c += 1) {
      const char = line[c];
      if (char === "(") depth += 1;
      else if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          const tail = line.slice(c + 1);
          // `): Promise<x> {`, `) => {`, `) {`, or a `=>` with a concise body.
          return /^\s*(:[^;{]*?)?\s*(=>|\{)/.test(tail);
        }
      }
    }
  }
  return false;
}

/** Is `name` on this line sitting in a function definition's parameter list? */
function isParameter(
  lines: string[],
  index: number,
  name: string,
  language: SymbolLanguage,
): boolean {
  const line = lines[index]!;
  const position = line.search(wordAt(name));
  if (position < 0) return false;

  const openIndex = openParenLine(lines, index, position);
  if (openIndex === null) return false;

  if (language === "python") {
    return /(^|\s)(def|lambda)\s/.test(lines[openIndex]!);
  }
  return isDefinitionParamList(lines, openIndex);
}

/** How many lines an import clause may span before we stop looking. */
const MAX_IMPORT_LINES = 60;

/** A line that could be part of an import clause and nothing else. */
function isImportMemberLine(line: string, language: SymbolLanguage): boolean {
  return language === "python"
    ? /^[\s\w,*()]*$/.test(line)
    : /^[\s\w$,*{}]*$/.test(line) || /^\s*(import|export)\b[\s\w$,*{}]*$/.test(line);
}

/**
 * `import { name } from "./x"` and friends → the module it comes from.
 *
 * Handles the multi-line form too, which is what most formatters produce as
 * soon as a file imports more than a couple of names — miss it and every
 * import in a typical TypeScript file is invisible.
 */
function importSpecifier(
  lines: string[],
  index: number,
  name: string,
  language: SymbolLanguage,
): string | null {
  const word = wordAt(name);
  const line = lines[index]!;

  if (language === "js") {
    const single = /^\s*import\s+(?:type\s+)?([^;]*?)\s*from\s*['"]([^'"]+)['"]/.exec(line);
    if (single && word.test(single[1]!)) return single[2]!;
    const required = /^\s*(?:const|let|var)\s+(.+?)\s*=\s*require\(\s*['"]([^'"]+)['"]/.exec(line);
    if (required && word.test(required[1]!)) return required[2]!;
  } else if (language === "python") {
    const from = /^\s*from\s+(\S+)\s+import\s+(.+)$/.exec(line);
    if (from && word.test(from[2]!)) return from[1]!;
    const plain = /^\s*import\s+(.+)$/.exec(line);
    if (plain && word.test(plain[1]!)) return name;
  } else {
    return null;
  }

  // Multi-line clause: walk up to the `import` that opened it, then down to the
  // module it names. Anything that is not clause-shaped ends the search.
  if (!isImportMemberLine(line, language)) return null;

  let start = index;
  const opensClause = language === "python" ? /^\s*from\s+\S+\s+import\s*\(/ : /^\s*import\b/;
  while (start >= 0 && index - start <= MAX_IMPORT_LINES && !opensClause.test(lines[start]!)) {
    if (!isImportMemberLine(lines[start]!, language)) return null;
    start -= 1;
  }
  if (start < 0 || index - start > MAX_IMPORT_LINES) return null;

  if (language === "python") {
    const from = /^\s*from\s+(\S+)\s+import\s*\(/.exec(lines[start]!);
    return from ? from[1]! : null;
  }

  for (let end = start; end < lines.length && end - start <= MAX_IMPORT_LINES; end += 1) {
    const specifier = /from\s*['"]([^'"]+)['"]/.exec(lines[end]!);
    if (specifier) return end >= index ? specifier[1]! : null;
  }
  return null;
}

/** Bindings that are not declarations in the file-wide sense but are in scope. */
function blockBinding(line: string, name: string, language: SymbolLanguage): SymbolKind | null {
  const escaped = escapeForRegExp(name);
  const end = "(?![\\w$])";

  if (language === "js") {
    // Destructuring: `const { tournamentId } = req;`, `const [first] = list;`
    if (new RegExp(`^\\s*(const|let|var)\\s*[{[][^;]*(?<![\\w$])${escaped}${end}`).test(line)) {
      return "variable";
    }
    // `for (const id of ids)`, `catch (error)`, `} catch (error) {`
    if (new RegExp(`\\b(for|catch)\\s*\\([^)]*(?<![\\w$])${escaped}${end}`).test(line)) {
      return "variable";
    }
    // Class field: `private readonly repo: Repo;`
    if (
      new RegExp(
        `^\\s*((private|public|protected|readonly|static|declare|abstract)\\s+)+${escaped}\\s*[?!:=]`,
      ).test(line)
    ) {
      return "variable";
    }
    return null;
  }

  if (language === "python") {
    if (new RegExp(`^\\s*(for|with)\\s.*(?<![\\w$])${escaped}${end}\\s*(in|as)?`).test(line)) {
      return "variable";
    }
    if (new RegExp(`^\\s*except\\s+.*\\sas\\s+${escaped}${end}`).test(line)) return "variable";
    return null;
  }

  return null;
}

/**
 * The binding `name` refers to at `clickLine`, searching upward through
 * enclosing scopes. Returns null when nothing in this file explains the name —
 * the caller should then look at the wider repo.
 */
export function resolveLocalBinding(request: LocalBindingRequest): LocalBinding | null {
  const { lines, firstLine, clickLine, name, language } = request;
  if (lines.length === 0) return null;

  const clickIndex = Math.min(Math.max(clickLine - firstLine, 0), lines.length - 1);
  const clickIndent = indentOf(lines[clickIndex]!);
  const word = wordAt(name);
  const isDeclaration = createDeclarationMatcher(name, language);
  const stopAt = Math.max(0, clickIndex - MAX_SCAN_LINES);

  for (let i = clickIndex; i >= stopAt; i -= 1) {
    const line = lines[i]!;
    if (!word.test(line)) continue;

    // Imports are file-scoped, so they are checked before the indentation
    // guard: a member inside a multi-line clause is indented, and a click on a
    // top-level declaration is not.
    const specifier = importSpecifier(lines, i, name, language);
    if (specifier) return { line: firstLine + i, kind: "import", moduleSpecifier: specifier };

    // A binding indented deeper than the click is in a sibling block, so it
    // cannot be what the click refers to.
    if (i !== clickIndex && indentOf(line) > clickIndent) continue;

    const declared = isDeclaration(line);
    if (declared) return { line: firstLine + i, kind: declared };

    const block = blockBinding(line, name, language);
    if (block) return { line: firstLine + i, kind: block };

    if (isParameter(lines, i, name, language)) {
      return { line: firstLine + i, kind: "parameter" };
    }
  }

  return null;
}
