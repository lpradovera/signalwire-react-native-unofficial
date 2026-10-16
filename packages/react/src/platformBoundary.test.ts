/**
 * @jest-environment node
 *
 * The lint rule that keeps this package platform-agnostic, run through ESLint
 * with the repo's own eslint.config.js on a file inside packages/react/src.
 */
import { join } from 'node:path';

import { Linter } from 'eslint';

const root = join(__dirname, '..', '..', '..');
// The config is CommonJS; ESLint's own loader uses a dynamic import Jest cannot run.
const config = require(join(root, 'eslint.config.js')) as Linter.Config[];
const file = join(root, 'packages', 'react', 'src', 'platformBoundary.fixture.ts');

function restricted(source: string): boolean {
  const linter = new Linter({ configType: 'flat', cwd: root });
  const messages = linter.verify(source, config, { filename: file });
  return messages.some((m) => m.ruleId === 'no-restricted-imports');
}

describe('no React Native imports in @signalwire/react', () => {
  it.each([
    "import { View } from 'react-native';",
    "import x from 'react-native/Libraries/Utilities/Platform';",
    "import x from 'react-native-webrtc';",
    "import x from '@react-native-community/netinfo';",
    "import normalizeColors from '@react-native/normalize-colors';",
    "import '@react-native/js-polyfills';",
    "import type { VirtualizedListProps } from '@react-native/virtualized-lists';",
    "import x from '@react-native/virtualized-lists/Lists/VirtualizedList';"
  ])('rejects %s', (source) => {
    expect(restricted(source)).toBe(true);
  });

  it.each(["import React from 'react';", "import { SignalWire } from '@signalwire/js';"])(
    'allows %s',
    (source) => {
      expect(restricted(source)).toBe(false);
    }
  );
});
