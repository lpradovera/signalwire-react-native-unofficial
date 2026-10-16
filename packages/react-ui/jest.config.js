/**
 * Two projects:
 * - `unit` maps @signalwire/web-components to a stub (jest/web-components.mock.js)
 *   and tests the createComponent wiring hermetically.
 * - `elements` loads the REAL Lit elements, so the wrappers' event mapping is
 *   tested against what the elements actually dispatch. Its files end in
 *   `.elements.test.tsx`.
 */
const tsJest = ['ts-jest', { tsconfig: { jsx: 'react-jsx', allowJs: true } }];

module.exports = {
  projects: [
    {
      displayName: 'unit',
      preset: 'ts-jest',
      testEnvironment: 'jsdom',
      testMatch: ['<rootDir>/src/**/*.test.ts', '<rootDir>/src/**/*.test.tsx'],
      testPathIgnorePatterns: ['\\.elements\\.test\\.tsx$'],
      transform: {
        // allowJs so the ESM-only @lit/react is transpiled to CJS for Jest.
        '^.+\\.[jt]sx?$': ['ts-jest', { tsconfig: { jsx: 'react-jsx', allowJs: true } }]
      },
      transformIgnorePatterns: ['node_modules/(?!(@lit/react)/)'],
      moduleNameMapper: {
        // See jest/web-components.mock.js for why the real Lit elements are not loaded.
        '^@signalwire/web-components(/.*)?$': '<rootDir>/jest/web-components.mock.js'
      }
    },
    {
      displayName: 'elements',
      testEnvironment: 'jsdom',
      testMatch: ['<rootDir>/src/**/*.elements.test.tsx'],
      // web-components' subpaths define only the `import` condition, as a
      // bundler resolves them; see the resolver.
      resolver: '<rootDir>/jest/import-condition-resolver.js',
      transform: { '^.+\\.[mc]?[jt]sx?$': tsJest },
      transformIgnorePatterns: [
        'node_modules/(?!(@lit|lit|lit-html|lit-element|@lit-labs|@signalwire|rxjs|uuid|marked|dompurify)/)'
      ]
    }
  ]
};
