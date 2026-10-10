import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['dist-test/', '.vscode-test/', 'test-results/', 'playwright-report/', 'dist/', 'node_modules/', '.claude/'] },
  js.configs.recommended,
  tseslint.configs.strict,
  {
    files: ['**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
  },
);
