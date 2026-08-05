# `@signalwire/rn-push-server`

Support server for `@signalwire/react-native`: a device-token registry and a
push sender for iOS VoIP (PushKit) and Android FCM.

SignalWire has no push infrastructure, so this covers the middle of the chain:

```
SignalWire ──webhook──▶ this server ──APNs/FCM──▶ device ──▶ reportIncomingPush()
```

See [`../docs/push-setup.md`](../docs/push-setup.md) for the whole picture,
including the Apple and Firebase setup this assumes you have done.

## Quick start

```bash
npm install
API_TOKEN=devsecret npm run dev -w @signalwire/rn-push-server
```

It starts with no senders configured, which is the useful state for wiring up
the client half: `/notify` accepts requests and tells you exactly why nothing
was delivered, rather than failing at boot.

```bash
curl -s localhost:3000/health

curl -X POST localhost:3000/devices \
  -H 'content-type: application/json' -H 'authorization: Bearer devsecret' \
  -d '{"externalUserId":"sub-abc","platform":"ios","token":"<pushkit-token>","environment":"sandbox"}'

curl -X POST localhost:3000/notify \
  -H 'content-type: application/json' -H 'authorization: Bearer devsecret' \
  -d '{"externalUserId":"sub-abc","correlationId":"call-123","from":"+15551234","fromName":"Ada"}'
```

## Configuration

All via environment. Both senders are optional — bring up one platform at a
time, which is the sane way to debug push.

| Variable | Required for | Notes |
| --- | --- | --- |
| `API_TOKEN` | — | Bearer token for every route except `/health`. **Unset means unauthenticated**; development only. |
| `PORT` | — | Default `3000` |
| `DEVICE_STORE_PATH` | — | Default `./.data/devices.json` |
| `APNS_TEAM_ID` | iOS | Apple Developer Team ID |
| `APNS_KEY_ID` | iOS | Key ID of the `.p8` |
| `APNS_P8_KEY` | iOS | Contents of the `.p8`. `\n`-escaped one-liners are accepted. |
| `IOS_BUNDLE_ID` | iOS | **Without** the `.voip` suffix — the sender appends it |
| `FCM_PROJECT_ID` | Android | Firebase project id |
| `FCM_CLIENT_EMAIL` | Android | From the service-account JSON |
| `FCM_PRIVATE_KEY` | Android | From the service-account JSON |

One `.p8` APNs key covers alert *and* VoIP pushes, sandbox *and* production.

## API

| Route | Purpose |
| --- | --- |
| `GET /health` | Liveness. The only unauthenticated route. |
| `POST /devices` | Register or refresh a token. Body: `externalUserId`, `platform`, `token`, `environment` (iOS). |
| `DELETE /devices/:token` | Remove one. Call on sign-out. |
| `GET /devices?externalUserId=` | List. Debugging aid. |
| `POST /notify` | Generic send. Body: `externalUserId`, `correlationId`, `from?`, `fromName?`. |
| `POST /webhooks/signalwire/inbound` | SignalWire adapter — normalises, then calls the same service. |

`/notify` returns a per-device breakdown rather than a bare 200:

```json
{
  "correlationId": "call-123",
  "attempted": 2,
  "delivered": 1,
  "pruned": 1,
  "results": [
    { "token": "aabb…", "platform": "ios", "status": "delivered" },
    { "token": "ccdd…", "platform": "android", "status": "token-expired" }
  ]
}
```

Dead tokens are pruned automatically on APNs `410`/`BadDeviceToken` and FCM
`UNREGISTERED`. A transient failure (a 503, a timeout) is reported as `failed`
and the token is **kept** — never prune on a transport error.

## ⚠️ The one unverified piece

`src/signalwire/webhook.ts` maps SignalWire's inbound-call webhook onto the
generic notification shape. **The exact payload was never confirmed** — it was
not documented in the SDK source this was built against.

The mapper therefore accepts several plausible field names (`call_id` / `callId`
/ `id`, `to_subscriber_id` / `subscriber_id` / `to`) and, when it cannot map a
body, returns **422 with the body echoed back**. Point a real webhook at it,
read the response, then delete the guesses and keep the branch that fires.

The critical constraint: the id you extract as `correlationId` **must be the
same id the SDK reports on `incomingCalls$`**. Fusion in `CallRegistry` matches
on it exactly.

## Layout, and why

```
src/
├── core/          ← generic. Knows nothing about SignalWire.
│   ├── types.ts              Device, CallNotification, PushSender
│   ├── DeviceStore.ts        interface + in-memory + JSON file
│   ├── ApnsVoipSender.ts     PushKit
│   ├── FcmSender.ts          data-only, high priority
│   ├── NotificationService.ts  fan-out, results, token pruning
│   └── jwt.ts                ES256/RS256 on node:crypto
├── routes/        ← generic HTTP surface
├── signalwire/    ← the ONLY SignalWire-aware file
└── app.ts         ← wiring, no `listen`
```

The `core` / `signalwire` split is deliberate. Everything under `core/` is a
standalone VoIP push service; the adapter is the only thing tying it to
SignalWire. Also: `externalUserId` is not called `subscriberId` for the same
reason — one column's worth of discipline now is the difference between
multi-tenant later and a migration.

## Production gaps

This is a scaffold. Before it carries real traffic:

- **Storage.** `JsonFileDeviceStore` rewrites the whole file per write and has
  no locking. Implement `DeviceStore` against Postgres.
- **Webhook authentication.** The API token protects the route, but you should
  verify SignalWire's own signature on the webhook.
- **Respond then send.** Pushes run inline so failures are visible while you
  wire things up. Under load, enqueue and return immediately — every second
  costs the caller a second of ringing.
- **Retries.** None. A 503 from APNs is reported and dropped.
- **Observability.** Delivery results are logged and returned but not stored.
  Persisting them is what makes "did the call ever reach the device?"
  answerable.

## Tests

```bash
npm test -w @signalwire/rn-push-server        # 29 tests, node:test, no network
npm run type-check -w @signalwire/rn-push-server
```

Senders are exercised through the `PushSender` interface, so the suite needs no
Apple or Google credentials. The JWT tests use freshly generated key pairs and
assert the two things that produce unhelpful 403s in production: ES256 with the
key id in the header, and a 64-byte JOSE signature rather than DER.
