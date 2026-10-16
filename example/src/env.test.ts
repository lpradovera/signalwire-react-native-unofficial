import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pickForPlatform } from './env';

test('Android takes its override', () => {
  assert.equal(pickForPlatform('android', 'http://mac:3000', 'http://localhost:3000'), 'http://localhost:3000');
});

test('iOS ignores the Android override', () => {
  assert.equal(pickForPlatform('ios', 'http://mac:3000', 'http://localhost:3000'), 'http://mac:3000');
});

test('an unset Android override falls back to the base value', () => {
  assert.equal(pickForPlatform('android', 'http://mac:3000', undefined), 'http://mac:3000');
});

// `EXPO_PUBLIC_SW_TOKEN_URL_ANDROID= npx expo run:android` blanks the override
// for one run; the shell's '' reaches the bundle. With `??` that '' won and
// switched the token fetch and device registration off on Android.
test('an empty Android override falls back to the base value', () => {
  assert.equal(pickForPlatform('android', 'http://mac:3000', ''), 'http://mac:3000');
});

test('nothing set, or only empty values, is unset', () => {
  assert.equal(pickForPlatform('android', undefined, undefined), undefined);
  assert.equal(pickForPlatform('android', '', ''), undefined);
  assert.equal(pickForPlatform('ios', '', 'http://localhost:3000'), undefined);
});
