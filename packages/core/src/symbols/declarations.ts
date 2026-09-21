/**
 * Where a symbol is declared, decided by reading one line at a time.
 *
 * Go-to-definition in the overlay is deliberately not a language server: a
 * review runs against a worktree we do not build, in languages we do not
 * parse, and the answer has to come back inside one click. So this is
 * ctags-shaped — per-language patterns for the shapes a declaration takes,
 * applied to candidate lines that already contain the identifier as a whole
 * word. It misses dynamic and generated declarations, and it can offer a
 * same-named declaration from another scope; the UI always shows what it
 * found before it moves the user anywhere.
 *
 * Both callers share these rules: the CLI runs them over `git grep` hits from
 * the repo, and the overlay runs them over the reviewed diff itself.
 */

export type SymbolLanguage =
  | "js"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "kotlin"
  | "csharp"
  | "swift"
  | "c"
  | "ruby"
  | "php"
  | "generic";

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "type"
  | "variable"
  | "macro"
  /** A function or method parameter, only ever resolved from local scope. */
  | "parameter"
  /** An import binding: not the definition, but the hop towards it. */
  | "import";

const EXTENSION_TO_LANGUAGE: Record<string, SymbolLanguage> = {
  js: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  ts: "js",
  tsx: "js",
  mts: "js",
  cts: "js",
  py: "python",
  pyi: "python",
  pyw: "python",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  cs: "csharp",
  swift: "swift",
  c: "c",
  h: "c",
  cc: "c",
  cpp: "c",
  cxx: "c",
  hpp: "c",
  hh: "c",
  m: "c",
  mm: "c",
  rb: "ruby",
  rake: "ruby",
  php: "php",
};

/** Files worth searching when the click came from a file of that language. */
const LANGUAGE_TO_EXTENSIONS: Record<SymbolLanguage, string[]> = {
  js: ["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"],
  python: ["py", "pyi", "pyw"],
  go: ["go"],
  rust: ["rs"],
  java: ["java"],
  kotlin: ["kt", "kts"],
  csharp: ["cs"],
  swift: ["swift"],
  c: ["c", "h", "cc", "cpp", "cxx", "hpp", "hh", "m", "mm"],
  ruby: ["rb", "rake"],
  php: ["php"],
  generic: [],
};

export function symbolLanguageForPath(path: string): SymbolLanguage {
  const base = path.split("/").pop() ?? path;
  const dotIndex = base.lastIndexOf(".");
  if (dotIndex <= 0) return "generic";
  return EXTENSION_TO_LANGUAGE[base.slice(dotIndex + 1).toLowerCase()] ?? "generic";
}

/**
 * Extensions a definition for `language` could live in — empty means "no
 * useful restriction", and the caller should search everything it has.
 */
export function symbolFileExtensions(language: SymbolLanguage): string[] {
  return LANGUAGE_TO_EXTENSIONS[language];
}

/** An identifier we are willing to look up. Keeps grep away from junk input. */
export function isSymbolName(value: string): boolean {
  return /^[A-Za-z_$][\w$]{0,127}$/.test(value);
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface RuleTemplate {
  kind: SymbolKind;
  /** `%s` is replaced by the escaped identifier. */
  source: string;
}

/** Right-hand identifier boundary. `\b` is wrong for names ending in `$`. */
const END = "(?![\\w$])";

/** Statement keywords that make a following `name(` a call, not a declaration. */
const NOT_STATEMENT = "(?!\\s*(?:return|if|while|for|switch|case|do|else|throw|new)\\b)";

const JS_RULES: RuleTemplate[] = [
  {
    kind: "function",
    source: "^\\s*(export\\s+)?(default\\s+)?(async\\s+)?function\\s*\\*?\\s*%s\\s*[(<]",
  },
  { kind: "class", source: "^\\s*(export\\s+)?(default\\s+)?(abstract\\s+)?class\\s+%s" + END },
  { kind: "type", source: "^\\s*(export\\s+)?(declare\\s+)?(interface|type|enum)\\s+%s\\s*[<={]" },
  { kind: "variable", source: "^\\s*(export\\s+)?(declare\\s+)?(const|let|var)\\s+%s\\s*[:=]" },
  // Object-literal and class-property functions: `name: () => …`, `name: function …`.
  { kind: "function", source: "^\\s*%s\\s*:\\s*(async\\s+)?(function\\b|\\(|<)" },
  // A method definition is a call-shaped line that opens a block; requiring the
  // trailing `{` is what keeps ordinary call sites out.
  {
    kind: "method",
    source:
      "^\\s*((public|private|protected|static|readonly|abstract|async|get|set|override)\\s+)*\\*?\\s*%s\\s*(<[^>]*>)?\\s*\\([^;]*\\)\\s*(:[^;{]*)?\\{\\s*$",
  },
];

const PYTHON_RULES: RuleTemplate[] = [
  { kind: "function", source: "^\\s*(async\\s+)?def\\s+%s\\s*\\(" },
  { kind: "class", source: "^\\s*class\\s+%s\\s*[(:]" },
  { kind: "variable", source: "^\\s*%s\\s*(:[^=]*)?=(?!=)" },
];

const GO_RULES: RuleTemplate[] = [
  { kind: "function", source: "^func\\s+%s\\s*[(\\[]" },
  { kind: "method", source: "^func\\s+\\([^)]*\\)\\s*%s\\s*[(\\[]" },
  { kind: "type", source: "^\\s*type\\s+%s" + END },
  { kind: "variable", source: "^\\s*(var|const)\\s+%s" + END },
];

const RUST_PUB = "(pub(\\([^)]*\\))?\\s+)?";
const RUST_RULES: RuleTemplate[] = [
  {
    kind: "function",
    source: `^\\s*${RUST_PUB}(default\\s+)?(const\\s+)?(async\\s+)?(unsafe\\s+)?(extern\\s+"[^"]*"\\s+)?fn\\s+%s\\s*[(<]`,
  },
  { kind: "class", source: `^\\s*${RUST_PUB}(struct|enum|trait|union)\\s+%s${END}` },
  { kind: "class", source: "^\\s*impl(<[^>]*>)?\\s+%s" + END },
  { kind: "type", source: `^\\s*${RUST_PUB}type\\s+%s\\s*[<=]` },
  { kind: "variable", source: `^\\s*${RUST_PUB}(const|static)\\s+(mut\\s+)?%s\\s*:` },
  { kind: "macro", source: "^\\s*macro_rules!\\s+%s" + END },
];

const JAVA_MODIFIER =
  "(public|private|protected|abstract|final|static|synchronized|native|default|sealed|strictfp)";
const JAVA_RULES: RuleTemplate[] = [
  {
    kind: "class",
    source: `^\\s*(${JAVA_MODIFIER}\\s+)*(class|interface|enum|record|@interface)\\s+%s${END}`,
  },
  {
    kind: "method",
    source: `^\\s*${NOT_STATEMENT}(${JAVA_MODIFIER}\\s+)+([\\w<>,.\\[\\]$?& ]+\\s+)?%s\\s*\\(`,
  },
  {
    kind: "variable",
    source: `^\\s*(${JAVA_MODIFIER}\\s+)+[\\w<>,.\\[\\]$?]+\\s+%s\\s*[=;]`,
  },
];

const KOTLIN_MODIFIER =
  "(public|private|internal|protected|open|override|suspend|inline|operator|abstract|final|external|tailrec|const|lateinit|data|sealed|enum|inner|annotation|value|companion)";
const KOTLIN_RULES: RuleTemplate[] = [
  {
    kind: "function",
    source: `^\\s*(${KOTLIN_MODIFIER}\\s+)*fun\\s+(<[^>]*>\\s*)?([\\w.<>]+\\.)?%s\\s*[(<]`,
  },
  { kind: "class", source: `^\\s*(${KOTLIN_MODIFIER}\\s+)*(class|interface|object)\\s+%s${END}` },
  { kind: "variable", source: `^\\s*(${KOTLIN_MODIFIER}\\s+)*(val|var)\\s+%s\\s*[:=]` },
  { kind: "type", source: "^\\s*(actual\\s+|expect\\s+)?typealias\\s+%s\\s*[<=]" },
];

const CSHARP_MODIFIER =
  "(public|private|protected|internal|static|virtual|override|abstract|async|sealed|extern|unsafe|partial|readonly|const|new)";
const CSHARP_RULES: RuleTemplate[] = [
  {
    kind: "class",
    source: `^\\s*(${CSHARP_MODIFIER}\\s+)*(class|interface|struct|enum|record|delegate)\\s+%s${END}`,
  },
  {
    kind: "method",
    source: `^\\s*${NOT_STATEMENT}(${CSHARP_MODIFIER}\\s+)+[\\w<>,.\\[\\]?]+\\s+%s\\s*(<[^>]*>)?\\s*\\(`,
  },
  {
    kind: "variable",
    source: `^\\s*(${CSHARP_MODIFIER}\\s+)+[\\w<>,.\\[\\]?]+\\s+%s\\s*([={;]|=>)`,
  },
];

const SWIFT_MODIFIER =
  "(public|private|internal|fileprivate|open|static|class|final|override|mutating|required|convenience|lazy|@\\w+)";
const SWIFT_RULES: RuleTemplate[] = [
  { kind: "function", source: `^\\s*(${SWIFT_MODIFIER}\\s+)*func\\s+%s\\s*[(<]` },
  {
    kind: "class",
    source: `^\\s*(${SWIFT_MODIFIER}\\s+)*(class|struct|enum|protocol|extension|actor)\\s+%s${END}`,
  },
  { kind: "variable", source: `^\\s*(${SWIFT_MODIFIER}\\s+)*(let|var)\\s+%s\\s*[:={]` },
  { kind: "type", source: "^\\s*(public\\s+|private\\s+)?typealias\\s+%s\\s*=" },
];

const C_RULES: RuleTemplate[] = [
  { kind: "macro", source: "^\\s*#\\s*define\\s+%s" + END },
  { kind: "class", source: "^\\s*(typedef\\s+)?(struct|class|union|enum|namespace)\\s+%s" + END },
  { kind: "type", source: "^\\s*(typedef|using)\\s+.*%s\\s*[;=]" },
  // A definition opens a block; a prototype ends the line. Both need a return
  // type or qualifier ahead of the name, which is what a bare call lacks.
  {
    kind: "function",
    source: `^\\s*${NOT_STATEMENT}[\\w:~*&<>,\\[\\]]+[\\w:~*&<>,\\[\\]\\s]*[\\s*&]%s\\s*\\([^;]*\\)\\s*(const\\s*)?(noexcept\\s*)?\\{\\s*$`,
  },
  {
    kind: "function",
    source: `^\\s*${NOT_STATEMENT}[\\w:~*&<>,\\[\\]]+[\\w:~*&<>,\\[\\]\\s]*[\\s*&]%s\\s*\\([^;]*\\)\\s*(const\\s*)?;\\s*$`,
  },
];

const RUBY_RULES: RuleTemplate[] = [
  { kind: "function", source: "^\\s*def\\s+(self\\.)?%s" + END },
  { kind: "class", source: "^\\s*(class|module)\\s+%s" + END },
  { kind: "variable", source: "^\\s*%s\\s*=(?!=)" },
];

const PHP_RULES: RuleTemplate[] = [
  {
    kind: "function",
    source: "^\\s*((public|private|protected|static|final|abstract)\\s+)*function\\s+&?%s\\s*\\(",
  },
  { kind: "class", source: "^\\s*((final|abstract)\\s+)*(class|interface|trait|enum)\\s+%s" + END },
  {
    kind: "variable",
    source:
      "^\\s*(const\\s+%s" + END + "|((public|private|protected|static|var)\\s+)+\\$%s" + END + ")",
  },
];

const GENERIC_RULES: RuleTemplate[] = [
  { kind: "function", source: "^\\s*(\\w+\\s+)*(function|func|fn|def|sub)\\s+%s" + END },
  {
    kind: "class",
    source:
      "^\\s*(\\w+\\s+)*(class|struct|interface|trait|protocol|object|module|record|enum)\\s+%s" +
      END,
  },
  { kind: "type", source: "^\\s*(\\w+\\s+)*(type|typedef|typealias)\\s+%s\\s*[<=;{]" },
  { kind: "variable", source: "^\\s*(\\w+\\s+)*(const|let|var|val|static)\\s+%s\\s*[:=]" },
  { kind: "function", source: "^\\s*%s\\s*[:=]\\s*(async\\s+)?(function\\b|\\()" },
  { kind: "macro", source: "^\\s*#\\s*define\\s+%s" + END },
];

const RULES: Record<SymbolLanguage, RuleTemplate[]> = {
  js: JS_RULES,
  python: PYTHON_RULES,
  go: GO_RULES,
  rust: RUST_RULES,
  java: JAVA_RULES,
  kotlin: KOTLIN_RULES,
  csharp: CSHARP_RULES,
  swift: SWIFT_RULES,
  c: C_RULES,
  ruby: RUBY_RULES,
  php: PHP_RULES,
  generic: GENERIC_RULES,
};

/**
 * A line-tester for one identifier in one language. Compiled once per lookup —
 * callers run it across thousands of candidate lines.
 */
export function createDeclarationMatcher(
  name: string,
  language: SymbolLanguage,
): (line: string) => SymbolKind | null {
  const escaped = escapeForRegExp(name);
  const compiled = RULES[language].map((rule) => ({
    kind: rule.kind,
    re: new RegExp(rule.source.replaceAll("%s", escaped)),
  }));

  return (line: string): SymbolKind | null => {
    // Cheap reject first: most `git grep` hits are uses, not declarations.
    if (!line.includes(name)) return null;
    for (const { kind, re } of compiled) {
      if (re.test(line)) return kind;
    }
    return null;
  };
}

/** One-shot form of `createDeclarationMatcher` for single-line checks. */
export function declarationKind(
  line: string,
  name: string,
  language: SymbolLanguage,
): SymbolKind | null {
  return createDeclarationMatcher(name, language)(line);
}

/**
 * How strongly a kind reads as "the" declaration when several files match.
 * Lower sorts first.
 */
export function symbolKindRank(kind: SymbolKind): number {
  switch (kind) {
    case "parameter":
      return 0;
    case "class":
      return 1;
    case "function":
      return 2;
    case "type":
      return 3;
    case "method":
      return 4;
    case "macro":
      return 5;
    case "variable":
      return 6;
    case "import":
      return 7;
  }
}
