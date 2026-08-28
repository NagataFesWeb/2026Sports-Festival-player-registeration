import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  js.configs.recommended,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: './tsconfig.json' },
      globals: {
        SpreadsheetApp: 'readonly', HtmlService: 'readonly', Session: 'readonly',
        PropertiesService: 'readonly', LockService: 'readonly', Utilities: 'readonly',
        FormApp: 'readonly', DriveApp: 'readonly', ScriptApp: 'readonly', UrlFetchApp: 'readonly',
        SlidesApp: 'readonly',
        GoogleAppsScript: 'readonly'
      }
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/explicit-function-return-type': 'error',
      '@typescript-eslint/no-explicit-any': 'error'
    }
  }
];
