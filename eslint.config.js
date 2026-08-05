const js = require('@eslint/js');
const reactHooks = require('eslint-plugin-react-hooks');
const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-restricted-syntax': [
        'error',
        { selector: 'ExportAllDeclaration', message: 'Enumerate the public surface explicitly.' }
      ]
    }
  },
  {
    // Tests deliberately use `require()` and `typeof import()` to exercise the
    // lazy-loading paths and to build jest.mock factories, which must not
    // close over outer consts.
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/consistent-type-imports': 'off'
    }
  },
  {
    // The whole point of @signalwire/react is that it runs unchanged in the
    // browser and in React Native. Enforce that here rather than in review —
    // this invariant erodes the first time someone needs "just one" import.
    files: ['packages/react/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['react-native', 'react-native/*', 'react-native-*', '@react-native-*'],
              message:
                '@signalwire/react must stay platform-agnostic. Put platform code in @signalwire/react-native and inject it through SignalWirePlatform or CallObserver.'
            }
          ]
        }
      ]
    }
  },
  { ignores: ['**/dist/**', '**/node_modules/**', 'example/**'] }
);
