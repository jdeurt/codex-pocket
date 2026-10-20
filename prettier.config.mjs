// Shared repository and bundled Engineering defaults.
/**
@type {import("prettier").Options}
*/
const config = {
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

export default config;
