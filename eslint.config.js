// eslint.config.js
import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";
import eslintPluginUnicorn from "eslint-plugin-unicorn";
import eslintNodePlugin from "eslint-plugin-n";
import pluginPromise from "eslint-plugin-promise";
import importPlugin from "eslint-plugin-import";

export default [
  {
    ignores: ["**/dist/*.js"],
  },

  js.configs.recommended,
  eslintNodePlugin.configs["flat/recommended-module"],
  pluginPromise.configs["flat/recommended"],
  importPlugin.flatConfigs.errors,
  eslintConfigPrettier,

  {
    settings: {
      "import/core-modules": ["bun:test"],
    },
    languageOptions: {
      globals: {
        ...globals.builtin,
        ...globals["shared-node-browser"],
      },
      sourceType: "module",
      ecmaVersion: "latest",
    },
    rules: {
      "import/no-commonjs": "error",
      "unicorn/prefer-module": "error",
    },
  },

  {
    files: ["**/*.js"],
    plugins: {
      unicorn: eslintPluginUnicorn,
    },
    rules: {
      "unicorn/catch-error-name": "error",
    },
  },

  {
    files: ["**/*.test.js", "**/test.js", "**/test/**/*.js", "browser.test.js"],
    languageOptions: {
      globals: {
        ...globals.node,
        test: "readonly",
        expect: "readonly",
        describe: "readonly",
        beforeAll: "readonly",
        afterAll: "readonly",
        beforeEach: "readonly",
        afterEach: "readonly",
      },
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    rules: {
      "promise/no-callback-in-promise": "off",
      "no-undef": "off",
      "unicorn/prevent-abbreviations": "off",
      "unicorn/no-null": "off",
      "unicorn/filename-case": "off",
      "unicorn/prefer-event-target": "off",
      "unicorn/prefer-export-from": "off",
    },
  },

  {
    files: [
      "**/jsx-runtime.js",
      "**/jsx-dev-runtime.js",
      "**/index.js",
      "**/test.js",
      "**/*.test.js",
    ],
    languageOptions: {
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
  },
];
