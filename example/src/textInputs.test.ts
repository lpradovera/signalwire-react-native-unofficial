import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/**
 * Every TextInput in the example is uncontrolled: no `value` prop.
 *
 * A controlled input writes the JS state back to the native field on every
 * render. On the iPhone, fast typing (XCUITest's typeText) lost characters
 * that way: "/private/rn-device-test" arrived as "/pvate/…" or "/pate/…" in
 * 16 of 22 first attempts, a run of characters near the start of the burst
 * replaced by the older value React wrote back. Any re-render of the screen
 * (the directory loading, call or registration state) does the same. Without
 * `value`, the native field owns the text and React only reads it.
 */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === 'node_modules' ? [] : sources(path);
    }
    return /\.tsx$/.test(name) ? [path] : [];
  });
}

const root = join(import.meta.dirname, '..');
const files = [...sources(join(root, 'src')), join(root, 'App.tsx')];

describe('example TextInputs', () => {
  it('finds the inputs it checks', () => {
    const count = files.reduce((n, file) => n + (readFileSync(file, 'utf8').match(/<TextInput\b/g)?.length ?? 0), 0);
    assert.ok(count >= 2, `expected the address and token inputs, found ${count}`);
  });

  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const inputs = [...text.matchAll(/<TextInput\b([\s\S]*?)\/>/g)].map((match) => match[1] ?? '');
    if (inputs.length === 0) {
      continue;
    }
    it(`${file.slice(root.length + 1)}: no TextInput is controlled`, () => {
      for (const props of inputs) {
        assert.doesNotMatch(props, /\bvalue=/, `a controlled TextInput:\n<TextInput${props}/>`);
      }
    });
  }

  it('the address field uses the URL keyboard, without smart insert/delete', () => {
    const home = readFileSync(join(root, 'src', 'screens', 'HomeScreen.tsx'), 'utf8');
    const address = [...home.matchAll(/<TextInput\b([\s\S]*?)\/>/g)]
      .map((match) => match[1] ?? '')
      .find((props) => props.includes('testID="sw-destination"'));
    assert.ok(address, 'the address field (testID sw-destination) is in HomeScreen.tsx');
    assert.match(address, /\bkeyboardType="url"/);
    assert.match(address, /\bsmartInsertDelete=\{false\}/);
    assert.match(address, /\bautoCapitalize="none"/);
    assert.match(address, /\bautoCorrect=\{false\}/);
  });
});
