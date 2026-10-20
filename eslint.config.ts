import { defineConfig } from "eslint/config";
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import prettierOptions from "./prettier.config.mjs";
import prettierRecommended from "eslint-plugin-prettier/recommended";
import reactDoctorLint from "eslint-plugin-react-doctor";
import reactHooks from "eslint-plugin-react-hooks";
import stylistic from "@stylistic/eslint-plugin";
import tseslint from "typescript-eslint";
import unicorn from "eslint-plugin-unicorn";

const tsconfigRootDir = fileURLToPath(new URL(".", import.meta.url));
const files = ["**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}"];
const tsFiles = ["**/*.{ts,tsx,mts,cts}"];
const reactRules = reactHooks.configs.flat["recommended-latest"].rules;

export default defineConfig([
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      ".marketplace-build/**",
      ".next/**",
      ".local/**",
      "playwright-report/**",
      "test-results/**",
      "next-env.d.ts",
      "src/components/ui/**",
      "src/hooks/use-highlighted-code.ts",
      "src/lib/highlighter.tsx",
    ],
  },

  { ...js.configs.recommended, files },
  { ...unicorn.configs.recommended, files },
  ...[...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked].map((entry) => ({
    ...entry,
    files: tsFiles,
  })),
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
      complexity: ["warn", { max: 30 }],
      eqeqeq: "warn",
      "no-lonely-if": "warn",
      // Structural offsets and small counts are self-explanatory; other values need names.
      "no-magic-numbers": ["warn", { ignore: [0, 1, 2] }],
      "no-shadow": "warn",
      "no-var": "error",
      "prefer-const": "warn",
      "sort-imports": "warn",
      "unicorn/no-repeated-call-wrappers": "warn",
      "unicorn/try-complexity": ["warn", { max: 5 }],
      // Existing CLI code relies on nested schema builders, descriptive boolean names,
      // in-place sorts, and explicit module setup. These newer preset rules obscure those patterns.
      "unicorn/consistent-boolean-name": "off",
      "unicorn/max-nested-calls": "off",
      "unicorn/no-array-sort": "off",
      "unicorn/no-top-level-side-effects": "off",
      "unicorn/no-unreadable-for-of-expression": "off",
      "unicorn/prefer-simple-condition-first": "off",
      "unicorn/no-array-reduce": "off",
      "unicorn/name-replacements": "off",
      "unicorn/prefer-top-level-await": "off",
      "unicorn/no-nested-ternary": "off",
      "unicorn/prefer-logical-operator-over-ternary": "off",
      "unicorn/no-useless-undefined": "off",
      "unicorn/prefer-string-replace-all": "off",
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
          selector: ":matches(TSAsExpression, TSTypeAssertion) > :matches(TSAsExpression, TSTypeAssertion)",
          message: "Validate the value instead of chaining type assertions.",
        },
      ],
    },
  },
  { files: tsFiles, rules: { "@typescript-eslint/no-unsafe-type-assertion": "error" } },
  { files: ["**/*.{jsx,tsx}"], languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } } },
  { files: ["**/*.{jsx,tsx}"], plugins: { "react-hooks": { rules: reactHooks.rules } }, rules: reactRules },
  { ...reactDoctorLint.configs.recommended, files: ["**/*.{jsx,tsx}"] },
  {
    files: tsFiles,
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir } },
  },
  prettierRecommended,
  {
    files,
    rules: {
      "prettier/prettier": ["error", prettierOptions, { usePrettierrc: false }],
      curly: ["error", "all"],
    },
  },
  {
    files,
    plugins: { "@stylistic": stylistic },
    rules: {
      "@stylistic/padding-line-between-statements": [
        "warn",
        { blankLine: "always", prev: "*", next: ["function", "class", "if", "switch", "for", "while", "do", "try"] },
        { blankLine: "always", prev: ["function", "class", "if", "switch", "for", "while", "do", "try"], next: "*" },
        { blankLine: "always", prev: { selector: "SwitchCase[consequent.length>0]" }, next: ["case", "default"] },
        { blankLine: "always", prev: "*", next: "return" },
      ],
    },
  },
  {
    files: ["src/server/**"],
    // Node streams and this bridge use the Node event API, including error and exit events.
    rules: { "unicorn/prefer-event-target": "off" },
  },
  {
    files: ["src/**", "tests/**"],
    // JSON-RPC, SQLite and React use null as a meaningful wire, storage or UI value.
    rules: { "unicorn/no-null": "off" },
  },
]);
