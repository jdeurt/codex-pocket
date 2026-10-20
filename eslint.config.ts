// AGENTS: Do not modify this file unless the user explicitly authorizes the change and specifies which rules to add,
// remove, or modify. Do not weaken rules to make checks pass.
import { defineConfig } from "eslint/config";
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import jsdoc from "eslint-plugin-jsdoc";
import policy from "./eslint-rules.ts";
import prettierOptions from "./prettier.config.mjs";
import prettierRecommended from "eslint-plugin-prettier/recommended";
import reactDoctorLint from "eslint-plugin-react-doctor";
import reactHooks from "eslint-plugin-react-hooks";
import stylistic from "@stylistic/eslint-plugin";
import tseslint from "typescript-eslint";
import unicorn from "eslint-plugin-unicorn";

const NODE_MODULES = "node_modules/**";
const MARKETPLACE_BUILD = ".marketplace-build/**";
const MARKETPLACE_VERIFY = ".marketplace-verify/**";

const CHAINED_TYPE_ASSERTION_SELECTOR =
  ":matches(TSAsExpression, TSTypeAssertion) > :matches(TSAsExpression, TSTypeAssertion)";
const CHAINED_TYPE_ASSERTION_MESSAGE = "Validate the value instead of chaining type assertions.";
const JSX_TSX = "**/*.{jsx,tsx}";

const VARIABLE_DECLARATION_SELECTOR =
  ":matches(VariableDeclaration[kind='const'], VariableDeclaration[kind='let'], ExportNamedDeclaration[declaration.kind='const'], ExportNamedDeclaration[declaration.kind='let'])";
const CONST_DECLARATION_SELECTOR =
  ":matches(VariableDeclaration[kind='const'], ExportNamedDeclaration[declaration.kind='const'])";
const LET_DECLARATION_SELECTOR =
  ":matches(VariableDeclaration[kind='let'], ExportNamedDeclaration[declaration.kind='let'])";
const FUNCTION_DECLARATION_SELECTOR =
  ":matches(FunctionDeclaration, ExportNamedDeclaration[declaration.type='FunctionDeclaration'], ExportDefaultDeclaration[declaration.type='FunctionDeclaration'])";
const FUNCTION_OVERLOAD_SELECTOR =
  ":matches(TSDeclareFunction, ExportNamedDeclaration[declaration.type='TSDeclareFunction'], ExportDefaultDeclaration[declaration.type='TSDeclareFunction'])";
const EXPORTED_CLASS_SELECTOR =
  ":matches(ExportNamedDeclaration, ExportDefaultDeclaration)[declaration.type='ClassDeclaration']";
const COMPLETED_SWITCH_CASE_SELECTOR = "SwitchCase[consequent.length>0]";

const DOCUMENTED_METHOD_FUNCTIONS =
  ":matches(MethodDefinition, TSAbstractMethodDefinition) > " +
  ":matches(FunctionExpression, TSEmptyBodyFunctionExpression)";
const DOCUMENTED_CALLABLE = ":matches(ArrowFunctionExpression, FunctionExpression)";
const TRANSPARENT_TYPESCRIPT = ":matches(TSSatisfiesExpression, TSAsExpression, TSTypeAssertion)";
const TOP_LEVEL_INITIALIZERS = [
  "Program > VariableDeclaration > VariableDeclarator",
  "Program > ExportNamedDeclaration > VariableDeclaration > VariableDeclarator",
  "Program > ExportDefaultDeclaration",
  "Program > ExpressionStatement > AssignmentExpression",
  "Program > TSExportAssignment",
];
const DOCUMENTED_FUNCTIONS = [
  "Program > :matches(FunctionDeclaration, TSDeclareFunction)",
  "Program > :matches(ExportNamedDeclaration, ExportDefaultDeclaration) > " +
    ":matches(FunctionDeclaration, TSDeclareFunction)",
  ...TOP_LEVEL_INITIALIZERS.flatMap((root) => [
    root + " > " + DOCUMENTED_CALLABLE,
    root +
      " > " +
      TRANSPARENT_TYPESCRIPT +
      " " +
      DOCUMENTED_CALLABLE +
      ":not(" +
      root +
      " > " +
      TRANSPARENT_TYPESCRIPT +
      " :not(" +
      TRANSPARENT_TYPESCRIPT +
      ") " +
      DOCUMENTED_CALLABLE +
      ")",
  ]),
  DOCUMENTED_METHOD_FUNCTIONS,
  ...["", TRANSPARENT_TYPESCRIPT + " > ", TRANSPARENT_TYPESCRIPT + " > " + TRANSPARENT_TYPESCRIPT + " > "].map(
    (wrappers) => "PropertyDefinition > " + wrappers + DOCUMENTED_CALLABLE
  ),
];
const VALUE_RETURN_SIGNATURE =
  ":matches(TSDeclareFunction, TSEmptyBodyFunctionExpression)[returnType]" +
  ":not([returnType.typeAnnotation.type='TSVoidKeyword'])" +
  ":not([returnType.typeAnnotation.type='TSUndefinedKeyword'])" +
  ":not([returnType.typeAnnotation.type='TSNeverKeyword'])" +
  ":not([returnType.typeAnnotation.typeName.name='Promise']" +
  "[returnType.typeAnnotation.typeArguments.params.0.type='TSVoidKeyword'])" +
  ":not([returnType.typeAnnotation.typeName.name='Promise']" +
  "[returnType.typeAnnotation.typeArguments.params.0.type='TSUndefinedKeyword'])" +
  ":not([returnType.typeAnnotation.typeName.name='Promise']" +
  "[returnType.typeAnnotation.typeArguments.params.0.type='TSNeverKeyword'])";
const RETURN_CONTEXTS = [
  ...DOCUMENTED_FUNCTIONS.map((context) => context + ":not(" + VALUE_RETURN_SIGNATURE + ")"),
  { context: VALUE_RETURN_SIGNATURE, forceRequireReturn: true },
];
const DOCUMENTED_CONTEXTS = [...DOCUMENTED_FUNCTIONS, "ClassDeclaration", "ClassExpression"];
const REQUIRED_DOCUMENTATION = [
  ...DOCUMENTED_CONTEXTS.filter((context) => context !== DOCUMENTED_METHOD_FUNCTIONS),
  "MethodDefinition",
  "TSAbstractMethodDefinition",
];

// The build copies this source into Engineering; the skill lists its required dependencies.
const resolutionRoot = fileURLToPath(new URL(".", import.meta.url));

// Keep each omission tied to an actual conflict; eslint-config-prettier also disables compatible rules.
export const stylisticConflicts: Record<string, string> = {
  "@stylistic/arrow-parens": "Prettier arrowParens=always conflicts with as-needed parentheses.",
  "@stylistic/brace-style": "Prettier keeps else/catch/finally beside the closing brace; Stroustrup separates them.",
  "@stylistic/comma-dangle": "Prettier trailingComma=es5 omits function argument commas required by always-multiline.",
  "@stylistic/indent-binary-ops":
    "Prettier indents wrapped string concatenation arguments further than this rule allows.",
  "@stylistic/member-delimiter-style": "Prettier uses semicolons in TypeScript members, not none/comma delimiters.",
  "@stylistic/operator-linebreak": "Prettier leaves assignment operators before a line break; before forbids this.",
  "@stylistic/quote-props": "Prettier quotes only necessary object keys; consistent-as-needed quotes all sibling keys.",
  "@stylistic/quotes": "Prettier singleQuote=false uses double quotes; the preset requires single quotes.",
  "@stylistic/semi": "Prettier semi=true requires semicolons; the preset forbids them.",
  "@stylistic/jsx-one-expression-per-line": "Prettier preserves inline JSX text and elements to preserve whitespace.",
  "@stylistic/multiline-ternary": "Prettier can wrap a ternary branch while retaining its condition and operator line.",
};

/**
Assemble the shared formatting, documentation, and code-quality policy.
@param options - Whether to enable project type information and where to resolve it.
@returns Ordered ESLint configurations for repository source and bundled reuse.
*/
export function createConfig(options: { typed?: boolean; tsconfigRootDir?: string } = {}) {
  const files = ["**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}"];
  const tsFiles = ["**/*.{ts,tsx,mts,cts}"];
  const reactRules = reactHooks.configs.flat["recommended-latest"].rules;

  return defineConfig([
    { ignores: ["dist/**", NODE_MODULES, MARKETPLACE_BUILD, MARKETPLACE_VERIFY] },
    { ...js.configs.recommended, files },
    { ...unicorn.configs.recommended, files },
    // Keep TypeScript-only core replacements scoped while enabling typed checks for JavaScript too.
    ...(options.typed
      ? [...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked]
      : [...tseslint.configs.strict, ...tseslint.configs.stylistic]
    ).map((entry: Record<string, unknown>) => ({ ...entry, files: options.typed && !entry.files ? files : tsFiles })),
    { files: ["**/*.{cjs,cts}"], languageOptions: { sourceType: "commonjs" } },
    {
      files,
      languageOptions: {
        globals: { console: "readonly", Bun: "readonly", process: "readonly", Buffer: "readonly" },
      },
      rules: {
        "max-lines": ["error", { max: 350, skipBlankLines: false, skipComments: false }],
        "max-len": ["error", { code: 120, tabWidth: 2 }],
        "no-duplicate-imports": "warn",
        "no-inner-declarations": "warn",
        "no-self-compare": "warn",
        "no-unreachable-loop": "warn",
        "no-use-before-define": "warn",
        complexity: "warn",
        eqeqeq: "warn",
        "no-lonely-if": "warn",
        // Structural offsets and small counts are self-explanatory; other values need names.
        "no-magic-numbers": ["warn", { ignore: [0, 1, 2] }],
        "no-shadow": "warn",
        "no-var": "error",
        "prefer-const": "warn",
        "sort-imports": "warn",
        "unicorn/no-repeated-call-wrappers": "warn",
        "unicorn/try-complexity": "warn",
        "unicorn/no-array-reduce": "off",
        "unicorn/name-replacements": "off",
        "unicorn/filename-case": ["error", { cases: { kebabCase: true, pascalCase: true } }],
      },
    },
    {
      files: tsFiles,
      plugins: { "@typescript-eslint": tseslint.plugin },
      rules: {
        "no-magic-numbers": "off",
        "no-shadow": "off",
        "no-use-before-define": "off",
        "@typescript-eslint/no-magic-numbers": ["warn", { ignore: [0, 1, 2] }],
        "@typescript-eslint/no-shadow": "warn",
        "@typescript-eslint/no-use-before-define": "warn",
        "@typescript-eslint/consistent-type-imports": "error",
        "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_.*", varsIgnorePattern: "^_.*" }],
        "no-restricted-syntax": [
          "error",
          {
            selector: CHAINED_TYPE_ASSERTION_SELECTOR,
            message: CHAINED_TYPE_ASSERTION_MESSAGE,
          },
        ],
      },
    },
    ...(options.typed
      ? [{ files: tsFiles, rules: { "@typescript-eslint/no-unsafe-type-assertion": "error" } as const }]
      : []),
    { files: [JSX_TSX], languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } } },
    { files: [JSX_TSX], plugins: { "react-hooks": { rules: reactHooks.rules } }, rules: reactRules },
    { ...reactDoctorLint.configs.recommended, files: [JSX_TSX] },
    ...(options.typed
      ? [
          {
            files,
            languageOptions: {
              parserOptions: { projectService: true, tsconfigRootDir: options.tsconfigRootDir ?? resolutionRoot },
            },
          },
        ]
      : []),
    prettierRecommended,
    {
      ...stylistic.configs.recommended,
      files,
      rules: Object.fromEntries(
        Object.entries(stylistic.configs.recommended.rules ?? {}).filter(
          ([rule]) => !Object.hasOwn(stylisticConflicts, rule)
        )
      ),
    },
    {
      files,
      rules: {
        "prettier/prettier": ["error", prettierOptions, { usePrettierrc: false }],
        curly: ["error", "all"],
        "unicorn/no-nested-ternary": unicorn.configs.recommended.rules?.["unicorn/no-nested-ternary"] ?? "error",
      },
    },
    {
      files,
      plugins: { jsdoc },
      settings: { jsdoc: { mode: "typescript", contexts: DOCUMENTED_CONTEXTS } },
      rules: {
        "jsdoc/require-jsdoc": [
          "error",
          {
            contexts: REQUIRED_DOCUMENTATION,
            require: { FunctionDeclaration: false },
            enableFixer: false,
            exemptEmptyConstructors: false,
            skipInterveningOverloadedDeclarations: true,
          },
        ],
        "jsdoc/require-description": "error",
        "jsdoc/require-param": [
          "error",
          { checkDestructured: false, checkDestructuredRoots: true, checkSetters: true, enableFixer: false },
        ],
        "jsdoc/check-param-names": ["error", { checkDestructured: false, allowExtraTrailingParamDocs: true }],
        "jsdoc/require-param-description": "error",
        "jsdoc/require-returns": ["error", { contexts: RETURN_CONTEXTS, checkConstructors: false, checkGetters: true }],
        "jsdoc/require-returns-description": "error",
      },
    },
    {
      files,
      plugins: { "@stylistic": stylistic, jdeurt: policy },
      rules: {
        "jdeurt/const-on-top": "error",
        "@stylistic/lines-between-class-members": [
          "error",
          "always",
          { exceptAfterSingleLine: false, exceptAfterOverload: true },
        ],
        "@stylistic/padding-line-between-statements": [
          "warn",
          { blankLine: "always", prev: "import", next: "*" },
          { blankLine: "any", prev: "import", next: "import" },
          { blankLine: "always", prev: { selector: VARIABLE_DECLARATION_SELECTOR }, next: "*" },
          {
            blankLine: "any",
            prev: { selector: CONST_DECLARATION_SELECTOR },
            next: { selector: CONST_DECLARATION_SELECTOR },
          },
          {
            blankLine: "any",
            prev: { selector: LET_DECLARATION_SELECTOR },
            next: { selector: LET_DECLARATION_SELECTOR },
          },
          { blankLine: "always", prev: "*", next: { selector: FUNCTION_DECLARATION_SELECTOR } },
          { blankLine: "always", prev: { selector: FUNCTION_DECLARATION_SELECTOR }, next: "*" },
          { blankLine: "always", prev: "*", next: { selector: FUNCTION_OVERLOAD_SELECTOR } },
          { blankLine: "always", prev: "*", next: ["class", "if", "switch", "for", "while", "do", "try"] },
          { blankLine: "always", prev: ["class", "if", "switch", "for", "while", "do", "try"], next: "*" },
          {
            blankLine: "always",
            prev: "*",
            next: {
              selector: EXPORTED_CLASS_SELECTOR,
            },
          },
          {
            blankLine: "always",
            prev: {
              selector: EXPORTED_CLASS_SELECTOR,
            },
            next: "*",
          },
          { blankLine: "always", prev: { selector: COMPLETED_SWITCH_CASE_SELECTOR }, next: ["case", "default"] },
          { blankLine: "always", prev: "*", next: "return" },
          {
            blankLine: "any",
            prev: { selector: FUNCTION_OVERLOAD_SELECTOR },
            next: [{ selector: FUNCTION_OVERLOAD_SELECTOR }, { selector: FUNCTION_DECLARATION_SELECTOR }],
          },
        ],
      },
    },
  ]);
}

const config = createConfig({ typed: true });

export default config;
