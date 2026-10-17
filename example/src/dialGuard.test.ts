import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDialGuard } from './dialGuard';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('a second start while a dial is pending is dropped, not dialled', async () => {
  const guard = createDialGuard();
  const first = deferred<string>();
  let dials = 0;
  const dial = () => {
    dials += 1;
    return first.promise;
  };

  const a = guard.run(dial);
  assert.equal(guard.pending, true);
  const b = guard.run(dial);

  assert.equal(dials, 1);
  assert.equal(await b, undefined);
  first.resolve('call-1');
  assert.equal(await a, 'call-1');
  assert.equal(guard.pending, false);
});

test('the next start dials again once the first has settled', async () => {
  const guard = createDialGuard();
  assert.equal(await guard.run(async () => 'call-1'), 'call-1');
  assert.equal(await guard.run(async () => 'call-2'), 'call-2');
});

test('a failed dial rejects to its caller and frees the guard', async () => {
  const guard = createDialGuard();
  await assert.rejects(
    guard.run(async () => {
      throw new Error('NotAllowedError');
    }),
    /NotAllowedError/
  );
  assert.equal(guard.pending, false);
  assert.equal(await guard.run(async () => 'call-2'), 'call-2');
});

test('pending observers hear the start and the end of each dial', async () => {
  const seen: boolean[] = [];
  const guard = createDialGuard((pending) => seen.push(pending));
  await guard.run(async () => 'call-1');
  await guard.run(async () => 'call-2').catch(() => undefined);
  assert.deepEqual(seen, [true, false, true, false]);
});
