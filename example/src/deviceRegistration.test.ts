import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  apnsEnvironmentFor,
  registrationPlan,
  registerDevice,
  registerWithRetry,
  RegistrationError
} from './deviceRegistration';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

test('a development-signed build registers as sandbox', () => {
  assert.equal(apnsEnvironmentFor('development'), 'sandbox');
});

// TestFlight, App Store and Ad Hoc builds get production PushKit tokens. A
// hard-coded 'sandbox' sent them to the sandbox host, which answered
// BadDeviceToken, and the server pruned the device.
test('a distribution-signed build registers as production', () => {
  assert.equal(apnsEnvironmentFor('production'), 'production');
});

test('no provisioning profile, as on an App Store install, is production', () => {
  assert.equal(apnsEnvironmentFor(null), 'production');
});

test('posts the registration, with the environment for iOS only', async () => {
  const bodies: unknown[] = [];
  const fetch: FetchLike = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response('{}', { status: 201 });
  };
  await registerDevice({
    url: 'http://mac/devices',
    externalUserId: 'alice',
    registration: { platform: 'ios', token: 'voip' },
    environment: 'production',
    fetch
  });
  await registerDevice({
    url: 'http://mac/devices',
    externalUserId: 'alice',
    registration: { platform: 'android', token: 'fcm' },
    environment: 'production',
    fetch
  });
  assert.deepEqual(bodies, [
    { externalUserId: 'alice', platform: 'ios', token: 'voip', environment: 'production' },
    { externalUserId: 'alice', platform: 'android', token: 'fcm' }
  ]);
});

test('a failed registration rejects with its status', async () => {
  const fetch: FetchLike = async () => new Response('down', { status: 503 });
  await assert.rejects(
    registerDevice({
      url: 'http://mac/devices',
      externalUserId: 'alice',
      registration: { platform: 'android', token: 'fcm' },
      environment: 'production',
      fetch
    }),
    (error: unknown) => error instanceof RegistrationError && error.status === 503
  );
});

/** Runs scheduled callbacks on demand, recording each delay. */
function manualClock() {
  const pending: Array<() => void> = [];
  const delays: number[] = [];
  return {
    delays,
    schedule: (run: () => void, delayMs: number) => {
      delays.push(delayMs);
      pending.push(run);
      return () => {
        const index = pending.indexOf(run);
        if (index >= 0) pending.splice(index, 1);
      };
    },
    async runNext() {
      pending.shift()?.();
      await new Promise((resolve) => setImmediate(resolve));
    },
    get pendingCount() {
      return pending.length;
    }
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

// The token is delivered once per launch (watchVoipToken drops a repeat of
// the same token), so one transient failure used to leave the device
// unregistered for the whole session.
test('retries a failure caused by the network, with growing delays', async () => {
  const clock = manualClock();
  let calls = 0;
  registerWithRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw new TypeError('Network request failed');
    },
    { delaysMs: [100, 200], schedule: clock.schedule, onError: () => undefined }
  );
  await flush();
  assert.equal(calls, 1);
  await clock.runNext();
  await clock.runNext();
  assert.equal(calls, 3);
  assert.deepEqual(clock.delays, [100, 200]);
  assert.equal(clock.pendingCount, 0);
});

test('keeps retrying at the longest delay', async () => {
  const clock = manualClock();
  registerWithRetry(
    async () => {
      throw new RegistrationError(502, 'bad gateway');
    },
    { delaysMs: [100, 200], schedule: clock.schedule, onError: () => undefined }
  );
  await flush();
  await clock.runNext();
  await clock.runNext();
  await clock.runNext();
  assert.deepEqual(clock.delays, [100, 200, 200, 200]);
});

test('does not retry a request the server rejected as invalid', async () => {
  const clock = manualClock();
  const errors: unknown[] = [];
  registerWithRetry(
    async () => {
      throw new RegistrationError(400, 'environment must be "sandbox" or "production" for iOS');
    },
    { delaysMs: [100], schedule: clock.schedule, onError: (error) => errors.push(error) }
  );
  await flush();
  assert.equal(clock.pendingCount, 0);
  assert.equal(errors.length, 1);
});

test('cancelling stops further attempts', async () => {
  const clock = manualClock();
  let calls = 0;
  const cancel = registerWithRetry(
    async () => {
      calls += 1;
      throw new TypeError('Network request failed');
    },
    { delaysMs: [100], schedule: clock.schedule, onError: () => undefined }
  );
  await flush();
  cancel();
  assert.equal(clock.pendingCount, 0);
  await clock.runNext();
  assert.equal(calls, 1);
});

test('a cancel during an attempt schedules nothing after it', async () => {
  const clock = manualClock();
  let fail: (error: Error) => void = () => undefined;
  const cancel = registerWithRetry(
    () => new Promise<void>((_resolve, reject) => (fail = reject)),
    { delaysMs: [100], schedule: clock.schedule, onError: () => undefined }
  );
  cancel();
  fail(new TypeError('Network request failed'));
  await flush();
  assert.equal(clock.pendingCount, 0);
});

// With fetchToken the reference is the token server's answer, unknown until
// the first token arrives. "Push registration skipped: no subscriber
// reference for this token" was logged at every launch for that wait (Len,
// step 10), although the server answered 'lentest-android' a moment later.
test('waits, without a warning, while the reference is not known yet', () => {
  assert.equal(registrationPlan(undefined), 'wait');
});

test('skips, with the warning, when there is no reference (a pasted token without one)', () => {
  assert.equal(registrationPlan(null), 'skip');
  assert.equal(registrationPlan(''), 'skip');
});

test('registers under a known reference', () => {
  assert.equal(registrationPlan('lentest-android'), 'register');
});
