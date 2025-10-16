import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

const recommendedRules = tsPlugin.configs.recommended?.rules ?? {};

export default [
  {
    ignores: ["dist/**"],
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      ...recommendedRules,
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
];
