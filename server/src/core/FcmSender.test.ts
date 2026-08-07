import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { dataPayload } from './FcmSender.js';

describe('dataPayload', () => {
  it('renames keys FCM reserves, which would fail the whole message', () => {
    // `from` is the natural name for a caller and APNs accepts it happily, so
    // this presents as "Android push is broken" while iOS works — same call,
    // same payload. FCM rejects the entire message with
    // `400 Invalid data payload key: from`.
    const data = dataPayload({ call_id: 'c1', from: '+15551234567', from_name: 'Ada' });

    assert.equal(data.from, undefined);
    assert.equal(data.sw_from, '+15551234567');
    assert.equal(data.call_id, 'c1');
    assert.equal(data.from_name, 'Ada');
  });

  it('stringifies values, because FCM rejects non-strings', () => {
    const data = dataPayload({ count: 3, flag: true });
    assert.equal(data.count, '3');
    assert.equal(data.flag, 'true');
  });

  it('drops null and undefined rather than sending the string "null"', () => {
    const data = dataPayload({ a: null, b: undefined, c: 'keep' });
    assert.deepEqual(Object.keys(data), ['c']);
  });
});
