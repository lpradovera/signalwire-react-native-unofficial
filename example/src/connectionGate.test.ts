import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { ConnectionGate } from './connectionGate';

test('resolves true at once when already connected', async () => {
  const gate = new ConnectionGate();
  gate.set(true);
  assert.equal(await gate.wait(15_000), true);
});

test('resolves on the connection itself, with no timer tick', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const gate = new ConnectionGate();
    let result: boolean | undefined;
    const waiting = gate.wait(15_000).then((connected) => (result = connected));
    await Promise.resolve();
    assert.equal(result, undefined);

    gate.set(true);
    await waiting;
    assert.equal(result, true);
  } finally {
    mock.timers.reset();
  }
});

test('resolves false at the timeout when the connection never comes', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const gate = new ConnectionGate();
    let result: boolean | undefined;
    const waiting = gate.wait(15_000).then((connected) => (result = connected));
    gate.set(false);
    mock.timers.tick(14_999);
    await Promise.resolve();
    assert.equal(result, undefined);
    mock.timers.tick(1);
    await waiting;
    assert.equal(result, false);
  } finally {
    mock.timers.reset();
  }
});

test('one connection releases every waiter, and a late timeout changes nothing', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const gate = new ConnectionGate();
    const waiting = Promise.all([gate.wait(1_000), gate.wait(2_000)]);
    gate.set(true);
    assert.deepEqual(await waiting, [true, true]);
    mock.timers.tick(5_000);
    assert.equal(await gate.wait(1_000), true);
  } finally {
    mock.timers.reset();
  }
});

test('wakes no timer while waiting (the old loop polled every 150 ms)', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const realSetTimeout = globalThis.setTimeout;
  let timers = 0;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    timers += 1;
    return realSetTimeout(...args);
  }) as typeof setTimeout;
  try {
    const gate = new ConnectionGate();
    const waiting = gate.wait(15_000);
    mock.timers.tick(10_000);
    gate.set(true);
    assert.equal(await waiting, true);
    assert.equal(timers, 1);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    mock.timers.reset();
  }
});
