import { createApp } from './app.js';
import { createSendersFromEnv, parseParkRoutes } from './config.js';
import { JsonFileDeviceStore } from './core/DeviceStore.js';
import { NotificationService } from './core/NotificationService.js';
import { BridgeTokenStore } from './core/BridgeTokenStore.js';
import { createDevAuthenticateCaller, createTokenRoutes } from './routes/token.js';
import { createCallEnderFromEnv } from './signalwire/endCall.js';
import { createSwmlRoutes } from './routes/swml.js';
import { createMinterFromEnv } from './signalwire/subscriberTokens.js';

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
    'API_TOKEN is unset — /devices and /notify are unauthenticated: anyone can register a device ' +
      'under any user, list every token, and push to anyone. Development only.'
  );
}

const minted = createMinterFromEnv();
let tokenRoutes;

if ('missing' in minted) {
  log('Subscriber tokens not configured', { needs: minted.missing });
} else if (process.env.ALLOW_UNAUTHENTICATED_TOKENS === '1') {
  const reference = process.env.DEV_SUBSCRIBER_REFERENCE ?? 'rn-example';
  log(
    'ALLOW_UNAUTHENTICATED_TOKENS=1 — /token will mint a subscriber token for ANY caller. ' +
      'Development only: replace authenticateCaller with your own user auth before deploying.',
    { defaultReference: reference }
  );
  tokenRoutes = createTokenRoutes({
    minter: minted.minter,
    authenticateCaller: createDevAuthenticateCaller(reference)
  });
} else {
  log(
    '/token is configured but has no authenticateCaller — every request will be rejected. ' +
      'Wire your own user auth in src/index.ts, or set ALLOW_UNAUTHENTICATED_TOKENS=1 for local testing.'
  );
  tokenRoutes = createTokenRoutes({ minter: minted.minter, authenticateCaller: () => null });
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
      'requests from anyone who can reach this server, who can then ring any subscriber. ' +
      'Development only.'
  );
} else if (!publicUrl) {
  log('SIGNALWIRE_SIGNING_KEY is set but PUBLIC_URL is not; signatures cover the public URL. Exiting.');
  process.exit(1);
}

let swmlRoutes;
try {
  swmlRoutes = createSwmlRoutes({
    tokens: bridgeTokens,
    service,
    publicUrl,
    signingKey,
    routes: parseParkRoutes(process.env.PARK_ROUTES),
    ringback: process.env.PARK_RINGBACK_URL,
    ringbackSeconds: process.env.PARK_RINGBACK_SECONDS
      ? Number(process.env.PARK_RINGBACK_SECONDS)
      : undefined,
    callEnder: createCallEnderFromEnv()
  });
} catch (error) {
  log(`${(error as Error).message} Exiting.`);
  process.exit(1);
}

const app = createApp({
  store,
  service,
  apiToken: process.env.API_TOKEN,
  tokenRoutes,
  swmlRoutes
});

app.listen(PORT, () => log('Listening', { port: PORT, storePath: STORE_PATH }));
