import { createApp } from './app.js';
import { createSendersFromEnv } from './config.js';
import { JsonFileDeviceStore } from './core/DeviceStore.js';
import { NotificationService } from './core/NotificationService.js';

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

const app = createApp({
  store,
  service: new NotificationService({ store, senders, log }),
  apiToken: process.env.API_TOKEN
});

app.listen(PORT, () => log('Listening', { port: PORT, storePath: STORE_PATH }));
