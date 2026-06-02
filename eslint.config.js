// ESLint 9 flat config for wren-mcp (TypeScript, ESM, Node stdio MCP server).
//   npm run lint        -> report
//   npm run lint:fix    -> auto-fix what's safe
//
// Mirrors the Wren repo's style: warnings allowed, no errors on a clean tree.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default [
  {
    // dist build output, deps, and the throwaway manual e2e harness (.mjs,
    // run by hand — not part of the typechecked/linted source or vitest run).
    ignores: ['dist/**', 'node_modules/**', 'tests/**/*.mjs'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Server + library source.
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },

  // Tests run under vitest (Node).
  {
    files: ['tests/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },

  // Project-wide rule normalization (applied last so it wins).
  {
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'prefer-const': 'warn',
      eqeqeq: ['warn', 'smart'],
    },
  },
];
