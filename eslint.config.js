// eslint.config.js
import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";
import eslintPluginUnicorn from "eslint-plugin-unicorn";
import eslintNodePlugin from "eslint-plugin-n";
import pluginPromise from "eslint-plugin-promise";
import { importX, createNodeResolver } from "eslint-plugin-import-x";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: ["**/dist/*.js"],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ["**/*.ts"],
  })),
  eslintNodePlugin.configs["flat/recommended-module"],
  pluginPromise.configs["flat/recommended"],
  importX.flatConfigs.errors,
  eslintConfigPrettier,

  {
    plugins: {
      unicorn: eslintPluginUnicorn,
    },
    settings: {
      "import-x/core-modules": ["bun:test"],
      "import-x/resolver-next": [createNodeResolver()],
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
      "import-x/no-commonjs": "error",
      "unicorn/prefer-module": "error",
    },
  },

  {
    files: ["**/*.ts"],
    rules: {
      "n/no-missing-import": "off",
      "n/no-unpublished-import": "off",
      "import-x/no-unresolved": "off",
    },
  },

  {
    files: ["**/*.d.ts"],
    rules: {
      "import-x/export": "off",
    },
  },

  {
    files: ["**/*.js"],
    rules: {
      "unicorn/catch-error-name": "error",
    },
  },

  {
    files: [
      "**/*.test.js",
      "**/*.test.ts",
      "**/test.js",
      "**/test/**/*.js",
      "browser.test.js",
    ],
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
      "n/no-unpublished-import": "off",
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
