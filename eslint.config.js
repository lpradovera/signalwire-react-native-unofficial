const js = require('@eslint/js');
const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-restricted-syntax': [
        'error',
        { selector: 'ExportAllDeclaration', message: 'Enumerate the public surface explicitly.' }
      ]
    }
  },
  { ignores: ['**/dist/**', '**/node_modules/**', 'example/**'] }
);
