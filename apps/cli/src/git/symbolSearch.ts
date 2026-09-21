/**
 * Where a symbol is declared, repo-wide.
 *
 * `git grep` finds every line that mentions the identifier as a whole word;
 * the shared declaration rules in the engine decide which of those lines is a
 * declaration rather than a use. That is deliberately not a language server:
 * it needs no build, no index, and no per-language toolchain on the reviewer's
 * machine, and it answers inside the click that asked.
 */

import path from "node:path";
import {
  createDeclarationMatcher,
  isSymbolName,
  isTestPath,
  resolveLocalBinding,
  symbolFileExtensions,
  symbolKindRank,
  symbolLanguageForPath,
  type LocalBinding,
  type SymbolKind,
  type SymbolLanguage,
} from "@guided-review/core";
import { readWorktreeTextFile } from "./fileBlob";
import { GitError, runGit } from "./run";

export interface SymbolDefinition {
  path: string;
  /** 1-indexed line the declaration is on. */
  line: number;
  kind: SymbolKind;
  /** The declaration and the lines under it. */
  snippet: string[];
  /** 1-indexed file line of `snippet[0]`. */
  snippetStartLine: number;
}

/** Most declarations handed back for one symbol. */
const MAX_RESULTS = 8;

/** Candidate lines considered before giving up — a very common word is not a lookup. */
const MAX_CANDIDATES = 5000;

/**
 * Lines shown around the declaration in the preview. Enough that a class or a
 * function body can actually be read by scrolling the card, without shipping a
 * whole file for a glance.
 */
const SNIPPET_BEFORE = 2;
const SNIPPET_AFTER = 40;

/** A lookup runs inside a click; a pathological repo must not hang the server. */
const GREP_TIMEOUT_MS = 5000;

/** Directories whose contents are vendored or generated, never a definition site. */
const IGNORED_PATH_SEGMENTS = [
  "node_modules/",
  "vendor/",
  "dist/",
  "build/",
  ".min.",
  "__snapshots__/",
];

interface Candidate {
  path: string;
  line: number;
  content: string;
}

/** `path\0line\0content` per hit — paths with colons stay intact. */
function parseGrepOutput(raw: string): Candidate[] {
  const candidates: Candidate[] = [];
  for (const entry of raw.split("\n")) {
    if (!entry) continue;
    const [path, lineNumber, ...rest] = entry.split("\0");
    const line = Number(lineNumber);
    if (!path || !Number.isInteger(line)) continue;
    candidates.push({ path, line, content: rest.join("\0") });
    if (candidates.length >= MAX_CANDIDATES) break;
  }
  return candidates;
}

function isNoise(path: string): boolean {
  return IGNORED_PATH_SEGMENTS.some((segment) => path.includes(segment));
}

/**
 * Lines mentioning `symbol` as a whole word, in files that could hold a
 * definition for it. Pathspecs narrow a TypeScript lookup to TypeScript files;
 * an unknown language searches everything git knows about.
 */
async function grepForSymbol(
  repoRoot: string,
  symbol: string,
  extensions: string[],
): Promise<Candidate[]> {
  const pathspecs = extensions.map((extension) => `*.${extension}`);
  try {
    const raw = await runGit(
      [
        "grep",
        "--no-color",
        // Untracked-but-not-ignored files count: a definition added minutes
        // ago in the working tree is exactly what a local review runs into.
        "--untracked",
        "-I",
        "-n",
        "-z",
        "-w",
        "-F",
        "-e",
        symbol,
        ...(pathspecs.length > 0 ? ["--", ...pathspecs] : []),
      ],
      repoRoot,
      // `git grep` exits 1 when nothing matched, which is not an error here.
      { allowExitCodes: [1], timeoutMs: GREP_TIMEOUT_MS },
    );
    return parseGrepOutput(raw);
  } catch (error) {
    if (error instanceof GitError) return [];
    throw error;
  }
}

/** A declaration found in a candidate line, before its snippet is read. */
type DeclarationSite = Omit<SymbolDefinition, "snippet" | "snippetStartLine">;

/**
 * How well a candidate path matches the module the name was imported from,
 * as a count of trailing path segments (more is better).
 *
 * Package specifiers and TypeScript path aliases cannot be resolved to a file
 * without a resolver config, but `@guided-review/ui/review/host` still says
 * plainly that `packages/ui/src/review/host.ts` is the file meant — and that a
 * same-named declaration in `apps/cli/src/ui/host.ts` is not.
 */
function importedPathMatch(specifier: string | null, candidatePath: string): number {
  if (!specifier) return 0;
  const segments = specifier.replace(/^@/, "").split("/").filter(Boolean);
  const withoutExtension = candidatePath.replace(/\.[^./]+$/, "");
  for (let take = Math.min(3, segments.length); take >= 1; take -= 1) {
    const tail = segments.slice(-take).join("/");
    if (withoutExtension.endsWith(`/${tail}`) || withoutExtension.endsWith(`/${tail}/index`)) {
      return take;
    }
  }
  return 0;
}

/**
 * Same file, then same directory, then the declaration that reads strongest —
 * and test files last unless the click came from one. A same-named local in
 * somebody's e2e spec is never the answer to a click in `src`.
 */
function rank(
  a: DeclarationSite,
  b: DeclarationSite,
  fromPath: string,
  importedFrom: string | null,
): number {
  const fromDir = fromPath.slice(0, fromPath.lastIndexOf("/") + 1);
  const fromTest = isTestPath(fromPath);
  const testness = (definition: DeclarationSite): number =>
    !fromTest && isTestPath(definition.path) ? 1 : 0;
  const proximity = (definition: DeclarationSite): number => {
    if (definition.path === fromPath) return 0;
    if (fromDir && definition.path.startsWith(fromDir)) return 1;
    return 2;
  };
  const byTestness = testness(a) - testness(b);
  if (byTestness !== 0) return byTestness;
  // An import says where the name came from; that beats mere proximity.
  const byImport =
    importedPathMatch(importedFrom, b.path) - importedPathMatch(importedFrom, a.path);
  if (byImport !== 0) return byImport;
  const byProximity = proximity(a) - proximity(b);
  if (byProximity !== 0) return byProximity;
  const byKind = symbolKindRank(a.kind) - symbolKindRank(b.kind);
  if (byKind !== 0) return byKind;
  const byDepth = a.path.split("/").length - b.path.split("/").length;
  if (byDepth !== 0) return byDepth;
  if (a.path !== b.path) return a.path.localeCompare(b.path);
  return a.line - b.line;
}

/** Reads each file at most once per lookup. */
function createFileReader(repoRoot: string): (filePath: string) => Promise<string[] | null> {
  const cache = new Map<string, Promise<string[] | null>>();
  return (filePath) => {
    let pending = cache.get(filePath);
    if (!pending) {
      pending = readWorktreeTextFile(repoRoot, filePath).then((file) => file?.lines ?? null);
      cache.set(filePath, pending);
    }
    return pending;
  };
}

/** Extensions and index files a module specifier may actually be on disk as. */
function moduleCandidates(base: string, language: SymbolLanguage): string[] {
  if (language === "python") return [`${base}.py`, `${base}/__init__.py`];
  const extensions = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"];
  const withoutExtension = base.replace(/\.(js|jsx|mjs|cjs)$/, "");
  return [
    ...(base === withoutExtension ? [] : [base]),
    ...extensions.map((extension) => `${withoutExtension}.${extension}`),
    ...extensions.map((extension) => `${withoutExtension}/index.${extension}`),
  ];
}

/**
 * The file a relative import points at. Package imports (`@nestjs/common`) and
 * TypeScript path aliases are not resolved — there is no tsconfig to read here,
 * and guessing would send the reader somewhere false.
 */
async function resolveImportedFile(
  fromPath: string,
  specifier: string,
  language: SymbolLanguage,
  readFile: (filePath: string) => Promise<string[] | null>,
): Promise<{ path: string; lines: string[] } | null> {
  if (!specifier.startsWith(".")) return null;

  const fromDir = path.posix.dirname(fromPath);
  let base: string;
  if (language === "python") {
    // `.mod` is this package, `..mod` the parent, and so on.
    const dots = /^\.+/.exec(specifier)?.[0].length ?? 1;
    const up = "../".repeat(dots - 1);
    base = path.posix.normalize(
      path.posix.join(fromDir, up, specifier.slice(dots).replace(/\./g, "/")),
    );
  } else {
    base = path.posix.normalize(path.posix.join(fromDir, specifier));
  }
  if (base.startsWith("..")) return null;

  for (const candidate of moduleCandidates(base, language)) {
    const lines = await readFile(candidate);
    if (lines) return { path: candidate, lines };
  }
  return null;
}

/** The strongest declaration of `symbol` in one file's lines, if any. */
function declarationInFile(
  lines: string[],
  symbol: string,
  language: SymbolLanguage,
): DeclarationSite | null {
  const matches = createDeclarationMatcher(symbol, language);
  let best: { line: number; kind: SymbolKind } | null = null;
  for (const [index, line] of lines.entries()) {
    const kind = matches(line);
    if (!kind) continue;
    if (!best || symbolKindRank(kind) < symbolKindRank(best.kind)) {
      best = { line: index + 1, kind };
    }
  }
  return best ? { path: "", ...best } : null;
}

/**
 * What the click resolves to inside its own file: a parameter, a local, or an
 * import — plus, when it is an import of a relative module, the declaration in
 * that module. This is the answer for most clicks, and it comes first.
 */
async function resolveFromClickedFile(
  symbol: string,
  fromPath: string,
  fromLine: number,
  language: SymbolLanguage,
  readFile: (filePath: string) => Promise<string[] | null>,
): Promise<{
  binding: LocalBinding | null;
  sites: DeclarationSite[];
  trailing: DeclarationSite[];
}> {
  const lines = await readFile(fromPath);
  if (!lines) return { binding: null, sites: [], trailing: [] };

  const binding = resolveLocalBinding({
    lines,
    firstLine: 1,
    clickLine: fromLine,
    name: symbol,
    language,
  });
  if (!binding) return { binding: null, sites: [], trailing: [] };

  const importSite: DeclarationSite = { path: fromPath, line: binding.line, kind: binding.kind };
  if (binding.kind !== "import" || !binding.moduleSpecifier) {
    return { binding, sites: [importSite], trailing: [] };
  }

  const target = await resolveImportedFile(fromPath, binding.moduleSpecifier, language, readFile);
  const declaration = target
    ? declarationInFile(target.lines, symbol, symbolLanguageForPath(target.path))
    : null;

  // The import line is worth showing either way — it is how the reader learns
  // the name came from another module — but it only leads the list when we
  // actually followed it. A package import we cannot resolve goes last, behind
  // whatever the repo-wide search turned up.
  return target && declaration
    ? { binding, sites: [{ ...declaration, path: target.path }, importSite], trailing: [] }
    : { binding, sites: [], trailing: [importSite] };
}

/**
 * Declarations of `symbol`, best first, each with the source lines the overlay
 * previews.
 *
 * Resolution order is the one a reader expects: what the name is bound to in
 * the file they clicked in, then the module it was imported from, then the
 * rest of the repository.
 */
export async function findSymbolDefinitions(
  repoRoot: string,
  symbol: string,
  fromPath: string,
  fromLine?: number,
): Promise<SymbolDefinition[]> {
  if (!isSymbolName(symbol)) return [];

  const language = symbolLanguageForPath(fromPath);
  const readFile = createFileReader(repoRoot);

  const local =
    fromLine && fromLine > 0
      ? await resolveFromClickedFile(symbol, fromPath, fromLine, language, readFile)
      : { binding: null, sites: [], trailing: [] };

  const candidates = await grepForSymbol(repoRoot, symbol, symbolFileExtensions(language));

  // Each candidate file gets its own matcher: a `.py` hit from a generic
  // lookup must be read with Python's rules, not the origin file's.
  const matchers = new Map<string, (line: string) => SymbolKind | null>();
  const declarations: DeclarationSite[] = [];

  for (const candidate of candidates) {
    if (isNoise(candidate.path)) continue;
    const candidateLanguage = symbolLanguageForPath(candidate.path);
    let matches = matchers.get(candidateLanguage);
    if (!matches) {
      matches = createDeclarationMatcher(symbol, candidateLanguage);
      matchers.set(candidateLanguage, matches);
    }
    const kind = matches(candidate.content);
    if (kind) declarations.push({ path: candidate.path, line: candidate.line, kind });
  }

  const importedFrom =
    local.binding?.kind === "import" ? (local.binding.moduleSpecifier ?? null) : null;

  // A name that resolved to a parameter or a local is lexical: same-named
  // locals elsewhere in the repo are noise, not candidates.
  const lexical =
    local.binding?.kind === "parameter" ||
    (local.binding?.kind === "variable" && local.sites[0]?.path === fromPath);

  const ranked = declarations
    .filter((declaration) => {
      const isLocalSite = local.sites.some(
        (site) => site.path === declaration.path && site.line === declaration.line,
      );
      if (isLocalSite) return false;
      if (!lexical) return true;
      return (
        declaration.path === fromPath ||
        (declaration.kind !== "variable" && declaration.kind !== "parameter")
      );
    })
    .sort((a, b) => rank(a, b, fromPath, importedFrom));

  const alreadyListed = (site: DeclarationSite): boolean =>
    ranked.some((entry) => entry.path === site.path && entry.line === site.line);
  const best = [
    ...local.sites,
    ...ranked,
    ...local.trailing.filter((site) => !alreadyListed(site)),
  ].slice(0, MAX_RESULTS);

  const results: SymbolDefinition[] = [];
  for (const declaration of best) {
    const lines = await readFile(declaration.path);
    if (!lines) continue;
    const snippetStartLine = Math.max(1, declaration.line - SNIPPET_BEFORE);
    results.push({
      ...declaration,
      snippet: lines.slice(snippetStartLine - 1, declaration.line + SNIPPET_AFTER),
      snippetStartLine,
    });
  }
  return results;
}
