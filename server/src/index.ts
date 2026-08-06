import { createApp } from './app.js';
import { createSendersFromEnv } from './config.js';
import { JsonFileDeviceStore } from './core/DeviceStore.js';
import { NotificationService } from './core/NotificationService.js';
import { createDevAuthenticateCaller, createTokenRoutes } from './routes/token.js';
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
  log('API_TOKEN is unset — every endpoint is unauthenticated. Development only.');
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

const app = createApp({
  store,
  service: new NotificationService({ store, senders, log }),
  apiToken: process.env.API_TOKEN,
  tokenRoutes
});

app.listen(PORT, () => log('Listening', { port: PORT, storePath: STORE_PATH }));
