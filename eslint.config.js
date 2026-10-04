// ESLint flat config for the whole monorepo. Type-aware rules are left to `npm run typecheck`
// (strict tsc); ESLint catches bug patterns tsc does not, plus React hook mistakes in the studio.
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/test-results/**',
      '**/playwright-report/**',
      '.claude/**',
      'apps/studio/public/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true },
      ],
      // Bit-twiddling DSP and codecs use these deliberately.
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Sanitizers for file names, tags and XML deliberately match control characters.
      'no-control-regex': 'off',
    },
  },
  {
    files: ['apps/studio/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // Tests and scripts may use loose typing for fixtures and fakes.
    files: ['**/test/**', '**/e2e/**', 'scripts/**', '**/scripts/**', '**/*.config.{js,ts,mjs}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Playwright fixtures that need no fixtures are written `async ({}, testInfo) => …`.
      'no-empty-pattern': 'off',
    },
  },
);
