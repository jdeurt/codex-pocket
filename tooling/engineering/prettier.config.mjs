// Shared repository and Engineering hook defaults.
export default {
  printWidth: 120,
  tabWidth: 2,
  useTabs: false,
  singleQuote: false,
  trailingComma: "es5",
  semi: true,
  bracketSpacing: true,
  arrowParens: "always",
  endOfLine: "lf",
  overrides: [{ files: "*.toml", options: { plugins: ["prettier-plugin-toml"] } }],
};
