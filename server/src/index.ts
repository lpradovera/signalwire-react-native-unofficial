import { createApp } from './app.js';
import { createSendersFromEnv, parseParkRoutes } from './config.js';
import { JsonFileDeviceStore } from './core/DeviceStore.js';
import { NotificationService } from './core/NotificationService.js';
import { BridgeTokenStore } from './core/BridgeTokenStore.js';
import { createDevAuthenticateCaller, createTokenRoutes } from './routes/token.js';
import { requireSignalWireSignature } from './signalwire/signature.js';
import { createCallEnderFromEnv } from './signalwire/endCall.js';
import { createSwmlRoutes } from './routes/swml.js';
import { createMinterFromEnv } from './signalwire/subscriberTokens.js';

import type { AuthenticateCaller } from './routes/token.js';

const PORT = Number(process.env.PORT ?? 3000);
const STORE_PATH = process.env.DEVICE_STORE_PATH ?? './.data/devices.json';

const log = (message: string, meta?: Record<string, unknown>): void => {
  console.log(JSON.stringify({ at: new Date().toISOString(), message, ...meta }));
};

const store = await JsonFileDeviceStore.open(STORE_PATH);
const { senders, missing } = createSendersFromEnv();

for (const gap of missing) {
  log('Push sender not configured', { platform: gap });
}

if (senders.length === 0) {
  log('No senders configured — /notify will accept requests and deliver nothing');
}

if (!process.env.API_TOKEN) {
  log(
    'API_TOKEN is unset — /notify is unauthenticated (and /devices too, unless DEVICE_AUTH=caller): ' +
      'anyone can push to anyone, register a device under any user, and list every token. ' +
      'Development only.'
  );
}

const minted = createMinterFromEnv();
const allowAnyCaller = process.env.ALLOW_UNAUTHENTICATED_TOKENS === '1';
const devReference = process.env.DEV_SUBSCRIBER_REFERENCE ?? 'rn-example';

// Who the caller is, for /token and (with DEVICE_AUTH=caller) /devices.
// Replace this with your own user auth: see AuthenticateCaller in routes/token.ts.
const authenticateCaller: AuthenticateCaller = allowAnyCaller
  ? createDevAuthenticateCaller(devReference)
  : () => null;

let tokenRoutes;

if ('missing' in minted) {
  log('Subscriber tokens not configured', { needs: minted.missing });
} else {
  if (allowAnyCaller) {
    log(
      'ALLOW_UNAUTHENTICATED_TOKENS=1 — /token will mint a subscriber token for ANY caller. ' +
        'Development only: replace authenticateCaller with your own user auth before deploying.',
      { defaultReference: devReference }
    );
  } else {
    log(
      '/token is configured but has no authenticateCaller — every request will be rejected. ' +
        'Wire your own user auth in src/index.ts, or set ALLOW_UNAUTHENTICATED_TOKENS=1 for local testing.'
    );
  }
  tokenRoutes = createTokenRoutes({ minter: minted.minter, authenticateCaller });
}

const deviceAuthMode = process.env.DEVICE_AUTH ?? 'api-token';
if (deviceAuthMode !== 'api-token' && deviceAuthMode !== 'caller') {
  log('DEVICE_AUTH must be "api-token" (the default) or "caller". Exiting.', { DEVICE_AUTH: deviceAuthMode });
  process.exit(1);
}
if (deviceAuthMode === 'caller') {
  log(
    allowAnyCaller
      ? 'DEVICE_AUTH=caller with ALLOW_UNAUTHENTICATED_TOKENS=1 — /devices trusts whoever the ' +
          'development stub says the caller is, which is anyone. Development only.'
      : 'DEVICE_AUTH=caller — /devices authenticates each request with authenticateCaller and ' +
          'scopes it to that user.'
  );
}

const service = new NotificationService({ store, senders, log });
const bridgeTokens = new BridgeTokenStore();

const publicUrl = process.env.PUBLIC_URL;
const signingKey = process.env.SIGNALWIRE_SIGNING_KEY;

if (!publicUrl) {
  log(
    'PUBLIC_URL is unset — /swml/bridge cannot give SignalWire a status_url, so a parked ' +
      'caller is left up, in silence, when the device hangs up. Set it to your tunnel.'
  );
}

if (!signingKey) {
  log(
    'SIGNALWIRE_SIGNING_KEY is unset — /swml/park, /swml/bridge and /swml/bridge/status accept ' +
      'requests from anyone who can reach this server, who can then ring any subscriber, and ' +
      '/webhooks/signalwire stays behind API_TOKEN, which SignalWire cannot send. Development only.'
  );
} else if (!publicUrl) {
  log('SIGNALWIRE_SIGNING_KEY is set but PUBLIC_URL is not; signatures cover the public URL. Exiting.');
  process.exit(1);
}

const app = createApp({
  store,
  service,
  apiToken: process.env.API_TOKEN,
  deviceAuth: deviceAuthMode === 'caller' ? authenticateCaller : undefined,
  signalWireSignature:
    signingKey && publicUrl ? requireSignalWireSignature({ signingKey, publicUrl }) : undefined,
  log,
  tokenRoutes,
  swmlRoutes: createSwmlRoutes({
    tokens: bridgeTokens,
    service,
    publicUrl,
    signingKey,
    routes: parseParkRoutes(process.env.PARK_ROUTES),
    ringback: process.env.PARK_RINGBACK_URL,
    callEnder: createCallEnderFromEnv()
  })
});

app.listen(PORT, () => log('Listening', { port: PORT, storePath: STORE_PATH }));
