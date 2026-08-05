import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InMemoryDeviceStore } from './DeviceStore.js';
import { NotificationService } from './NotificationService.js';
import { TokenExpiredError } from './types.js';

import type { Device, PushPayload, PushSender } from './types.js';

function recordingSender(
  platform: 'ios' | 'android',
  behaviour: (device: Device) => void = () => undefined
): PushSender & { sent: Array<{ device: Device; payload: PushPayload }> } {
  const sent: Array<{ device: Device; payload: PushPayload }> = [];
  return {
    platform,
    sent,
    async send(device, payload) {
      behaviour(device);
      sent.push({ device, payload });
    }
  };
}

async function storeWith(...devices: Array<Partial<Device>>): Promise<InMemoryDeviceStore> {
  const store = new InMemoryDeviceStore();
  for (const [index, device] of devices.entries()) {
    await store.register({
      externalUserId: device.externalUserId ?? 'user-1',
      platform: device.platform ?? 'ios',
      token: device.token ?? `token-${index}`,
      environment: device.environment ?? 'production'
    });
  }
  return store;
}

describe('NotificationService', () => {
  it('sends to every device the user has registered', async () => {
    const store = await storeWith(
      { token: 'ios-1', platform: 'ios' },
      { token: 'android-1', platform: 'android' }
    );
    const ios = recordingSender('ios');
    const android = recordingSender('android');
    const service = new NotificationService({ store, senders: [ios, android] });

    const result = await service.notify({ externalUserId: 'user-1', correlationId: 'call-9' });

    assert.equal(result.attempted, 2);
    assert.equal(result.delivered, 2);
    assert.equal(ios.sent.length, 1);
    assert.equal(android.sent.length, 1);
  });

  it('puts the correlation id on the payload as call_id', async () => {
    const store = await storeWith({ token: 'ios-1' });
    const ios = recordingSender('ios');
    const service = new NotificationService({ store, senders: [ios] });

    await service.notify({ externalUserId: 'user-1', correlationId: 'call-9' });

    assert.equal(ios.sent[0]?.payload.call_id, 'call-9');
  });

  it('generates a uuid for iOS but not for Android', async () => {
    const store = await storeWith(
      { token: 'ios-1', platform: 'ios' },
      { token: 'android-1', platform: 'android' }
    );
    const ios = recordingSender('ios');
    const android = recordingSender('android');
    const service = new NotificationService({
      store,
      senders: [ios, android],
      uuid: () => 'fixed-uuid'
    });

    await service.notify({ externalUserId: 'user-1', correlationId: 'call-9' });

    assert.equal(ios.sent[0]?.payload.uuid, 'fixed-uuid');
    assert.equal(android.sent[0]?.payload.uuid, undefined);
  });

  it('substitutes placeholders for a missing caller', async () => {
    const store = await storeWith({ token: 'ios-1' });
    const ios = recordingSender('ios');
    const service = new NotificationService({ store, senders: [ios] });

    await service.notify({ externalUserId: 'user-1', correlationId: 'call-9' });

    assert.equal(ios.sent[0]?.payload.from, 'Unknown');
    assert.equal(ios.sent[0]?.payload.from_name, 'Unknown caller');
  });

  it('ignores devices belonging to other users', async () => {
    const store = await storeWith(
      { token: 'mine', externalUserId: 'user-1' },
      { token: 'theirs', externalUserId: 'user-2' }
    );
    const ios = recordingSender('ios');
    const service = new NotificationService({ store, senders: [ios] });

    const result = await service.notify({ externalUserId: 'user-1', correlationId: 'call-9' });

    assert.equal(result.attempted, 1);
    assert.equal(ios.sent[0]?.device.token, 'mine');
  });

  it('reports zero attempts when the user has no devices', async () => {
    const store = new InMemoryDeviceStore();
    const service = new NotificationService({ store, senders: [recordingSender('ios')] });

    const result = await service.notify({ externalUserId: 'nobody', correlationId: 'call-9' });

    assert.deepEqual(
      { attempted: result.attempted, delivered: result.delivered },
      { attempted: 0, delivered: 0 }
    );
  });

  it('prunes a token the provider reports as dead', async () => {
    const store = await storeWith({ token: 'dead' });
    const ios = recordingSender('ios', (device) => {
      throw new TokenExpiredError(device.token);
    });
    const service = new NotificationService({ store, senders: [ios] });

    const result = await service.notify({ externalUserId: 'user-1', correlationId: 'call-9' });

    assert.equal(result.pruned, 1);
    assert.equal((await store.all()).length, 0);
  });

  it('keeps a live token when a sibling token is dead', async () => {
    const store = await storeWith({ token: 'dead' }, { token: 'alive' });
    const ios = recordingSender('ios', (device) => {
      if (device.token === 'dead') {
        throw new TokenExpiredError(device.token);
      }
    });
    const service = new NotificationService({ store, senders: [ios] });

    const result = await service.notify({ externalUserId: 'user-1', correlationId: 'call-9' });

    assert.equal(result.delivered, 1);
    assert.equal(result.pruned, 1);
    assert.deepEqual((await store.all()).map((device) => device.token), ['alive']);
  });

  it('records a transport failure without pruning the token', async () => {
    const store = await storeWith({ token: 'flaky' });
    const ios = recordingSender('ios', () => {
      throw new Error('APNs 503: overloaded');
    });
    const service = new NotificationService({ store, senders: [ios] });

    const result = await service.notify({ externalUserId: 'user-1', correlationId: 'call-9' });

    assert.equal(result.delivered, 0);
    assert.equal(result.pruned, 0);
    assert.equal(result.results[0]?.status, 'failed');
    assert.match(result.results[0]?.error ?? '', /503/);
    assert.equal((await store.all()).length, 1, 'a transient failure must not drop the token');
  });

  it('reports a platform with no configured sender rather than throwing', async () => {
    const store = await storeWith({ token: 'android-1', platform: 'android' });
    const service = new NotificationService({ store, senders: [recordingSender('ios')] });

    const result = await service.notify({ externalUserId: 'user-1', correlationId: 'call-9' });

    assert.equal(result.results[0]?.status, 'failed');
    assert.match(result.results[0]?.error ?? '', /No sender configured/);
  });

  it('delivers to remaining devices even if one sender hangs up', async () => {
    const store = await storeWith(
      { token: 'bad', platform: 'ios' },
      { token: 'good', platform: 'android' }
    );
    const ios = recordingSender('ios', () => {
      throw new Error('boom');
    });
    const android = recordingSender('android');
    const service = new NotificationService({ store, senders: [ios, android] });

    const result = await service.notify({ externalUserId: 'user-1', correlationId: 'call-9' });

    assert.equal(result.delivered, 1);
    assert.equal(android.sent.length, 1);
  });
});
