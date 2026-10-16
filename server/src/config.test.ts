import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';

import { createSendersFromEnv, parseParkRoutes } from './config.js';

describe('parseParkRoutes', () => {
  it('maps each destination to its subscriber', () => {
    assert.deepEqual(parseParkRoutes('+15551234567:rn-example, +15559998888 : other-user'), {
      '+15551234567': 'rn-example',
      '+15559998888': 'other-user'
    });
  });

  it('is empty when unset', () => {
    assert.deepEqual(parseParkRoutes(undefined), {});
    assert.deepEqual(parseParkRoutes(''), {});
  });

  it('skips malformed pairs rather than routing to an empty name', () => {
    assert.deepEqual(parseParkRoutes('+15551234567,:nobody,+15550000000:'), {});
  });

  it('splits on the last colon, so a SIP destination keeps its own', () => {
    assert.deepEqual(parseParkRoutes('sip:park@example.sip.signalwire.com:rn-example'), {
      'sip:park@example.sip.signalwire.com': 'rn-example'
    });
  });
});

describe('createSendersFromEnv', () => {
  const ec = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  });

  it('names what each missing platform needs', () => {
    const { senders, missing } = createSendersFromEnv({});
    assert.equal(senders.length, 0);
    assert.equal(missing.length, 2);
    assert.match(missing[0] ?? '', /APNS_TEAM_ID/);
    assert.match(missing[1] ?? '', /FCM_PROJECT_ID/);
  });

  it('builds the iOS sender alone when only APNs is configured', () => {
    const { senders, missing } = createSendersFromEnv({
      APNS_TEAM_ID: 'TEAM',
      APNS_KEY_ID: 'KEY',
      // One line with literal \n, the way a .env file holds a PEM.
      APNS_P8_KEY: ec.privateKey.replace(/\n/g, '\\n'),
      IOS_BUNDLE_ID: 'com.example.app'
    });
    assert.deepEqual(senders.map((sender) => sender.platform), ['ios']);
    assert.equal(missing.length, 1);
  });

  it('builds the Android sender when FCM is configured', () => {
    const { senders } = createSendersFromEnv({
      FCM_PROJECT_ID: 'proj',
      FCM_CLIENT_EMAIL: 'svc@proj.iam.gserviceaccount.com',
      FCM_PRIVATE_KEY: 'pem'
    });
    assert.deepEqual(senders.map((sender) => sender.platform), ['android']);
  });
});
