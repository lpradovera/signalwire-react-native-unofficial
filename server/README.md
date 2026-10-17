# `@signalwire/rn-push-server`

> **Scaffold, not a product.** This exists to give the example apps a working
> backend and to iterate on ideas for what one should do. The deliverable in
> this repository is the client SDK; this is expected to be reimplemented inside
> whatever product consumes it. It is `private: true` and never published.
>
> Treat every seam marked *replace me* as exactly that — notably
> `authenticateCaller` in [`src/routes/token.ts`](src/routes/token.ts) and the
> payload mapping in [`src/signalwire/webhook.ts`](src/signalwire/webhook.ts).
> There is no persistence story beyond a JSON file, no rate limiting, and no
> multi-tenancy. Per-user authentication on `/devices` is opt-in
> (`DEVICE_AUTH=caller`) and only as good as your `authenticateCaller`. Do not
> deploy it as-is.

Support server for `@signalwire/react-native`: a device-token registry and a
push sender for iOS VoIP (PushKit) and Android FCM.

SignalWire has no push infrastructure, so this covers the middle of the chain:

```
SignalWire ──webhook──▶ this server ──APNs/FCM──▶ device ──▶ reportIncomingPush()
```

**New to this? Start at [`../docs/push-setup.md`](../docs/push-setup.md)** — it
walks the whole chain in order, from the Apple and Firebase setup this
assumes you have done, through to verifying each link separately.

## Quick start

Needs Node 20.19+ or 22.9+: `npm run dev` and `npm start` pass
`--env-file-if-exists`, which older releases reject with `bad option`.

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

[`.env.example`](.env.example) lists every variable; copy it to `.env`.

| Variable | Required for | Notes |
| --- | --- | --- |
| `API_TOKEN` | — | Bearer token for `/notify`, for `/devices` unless `DEVICE_AUTH=caller`, and for `/webhooks/signalwire` unless `SIGNALWIRE_SIGNING_KEY` is set. A backend's secret, never an app's. **Unset means unauthenticated**: anyone can push to anyone, and (without `DEVICE_AUTH=caller`) register a device under any user and list every token. Development only. |
| `DEVICE_AUTH` | apps registering themselves | `api-token` (default): `/devices` trusts the body's `externalUserId` and is guarded only by `API_TOKEN`. `caller`: `/devices` is authenticated per request by `authenticateCaller` (the same seam as `/token`), outside the `API_TOKEN` guard, and each request registers, lists and deletes only that user's devices. See [Device registration](#device-registration). |
| `PORT` | — | Default `3000` |
| `DEVICE_STORE_PATH` | — | Default `./.data/devices.json` |
| `SIGNALWIRE_SPACE` | `/token`, ending callers | e.g. `example.signalwire.com` |
| `SIGNALWIRE_PROJECT_ID` | `/token`, ending callers | |
| `SIGNALWIRE_API_TOKEN` | `/token`, ending callers | Also used to `calling.end` a parked caller when the device hangs up or the user declines |
| `ALLOW_UNAUTHENTICATED_TOKENS` | — | `1` mints a subscriber token for **any** caller. Development only; see [Subscriber tokens](#subscriber-tokens) |
| `DEV_SUBSCRIBER_REFERENCE` | — | Default reference for the development `/token` stub, **and** the park's fallback subscriber: with it set, every park that `?subscriber=` and `PARK_ROUTES` do not resolve rings this one user |
| `PUBLIC_URL` | parked-caller flow | Base URL SignalWire reaches (your tunnel). Builds the bridge's `status_url` — without it a parked caller is left up when the device hangs up — and is the URL signatures are checked against |
| `SIGNALWIRE_SIGNING_KEY` | production | The space's Signing Key. Set, `/swml/park`, `/swml/bridge`, `/swml/bridge/status` and `/webhooks/signalwire` refuse requests SignalWire did not sign (the webhook then needs no `API_TOKEN`). Unset, anyone who can reach the server can ring any subscriber. Needs `PUBLIC_URL` |
| `PARK_ROUTES` | phone numbers | Dialled destination → subscriber, e.g. `+15551234567:rn-example,+15559998888:other-user` |
| `PARK_RINGBACK_URL` | — | Your own ringback recording, replacing the generated `ring:15.0:us` (this server's `/swml/ringback` serves one) |
| `PARK_RINGBACK_SECONDS` | with `PARK_RINGBACK_URL` | The recording's length in seconds (`6` for `/swml/ringback`). `play` cannot loop, so the park repeats the URL to fill its 60 s; the server refuses to start without it rather than guess |
| `APNS_TEAM_ID` | iOS | Apple Developer Team ID |
| `APNS_KEY_ID` | iOS | Key ID of the `.p8` |
| `APNS_P8_KEY` | iOS | Contents of the `.p8`. `\n`-escaped one-liners are accepted. |
| `IOS_BUNDLE_ID` | iOS | **Without** the `.voip` suffix — the sender appends it |
| `FCM_PROJECT_ID` | Android | Firebase project id |
| `FCM_CLIENT_EMAIL` | Android | From the service-account JSON |
| `FCM_PRIVATE_KEY` | Android | From the service-account JSON |

One `.p8` APNs key covers alert *and* VoIP pushes, sandbox *and* production.

## API

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /health` | none | Liveness. |
| `POST /token` | `authenticateCaller` | Mint a subscriber token. See [Subscriber tokens](#subscriber-tokens). |
| `POST /devices` | `API_TOKEN`, or `authenticateCaller` with `DEVICE_AUTH=caller` | Register or refresh a token. Body: `externalUserId` (optional with `DEVICE_AUTH=caller`, and must match the caller), `platform`, `token`, `environment` (iOS). |
| `DELETE /devices/:token` | as `POST /devices` | Remove one. Call on sign-out. With `DEVICE_AUTH=caller`, only the caller's own (another user's is a `404`). |
| `GET /devices?externalUserId=` | as `POST /devices` | List. Debugging aid. With `DEVICE_AUTH=caller`, the caller's devices only; the query is ignored. |
| `POST /notify` | `API_TOKEN` | Generic send. Body: `externalUserId`, `correlationId`, `from?`, `fromName?`. |
| `POST /webhooks/signalwire/inbound` | SignalWire signature with `SIGNALWIRE_SIGNING_KEY`, else `API_TOKEN` | SignalWire adapter — normalises, then calls the same service. Without a signing key only a caller you control can send `API_TOKEN`; SignalWire cannot. |
| `POST /swml/park` | SignalWire signature | Park the caller, push the user's devices. Subscriber from `?subscriber=` on this URL, then `PARK_ROUTES`. |
| `POST /swml/bridge` | SignalWire signature + bridge token | Join the answering device to the parked caller. |
| `POST /swml/bridge/status` | SignalWire signature | The bridge's status callback; ends the caller once the device leg ends. |
| `POST /swml/decline` | bridge token | The app reports a decline. Body: `bridgeToken`. Ends the parked caller (`204`); `409` if the call was already answered or declined. |
| `GET /swml/ringback` | none | A generated ringback WAV. |

"SignalWire signature" applies only with `SIGNALWIRE_SIGNING_KEY` set; without
it those routes are open, and the server says so at boot. The bridge token is
pushed only to the user's devices, single-use and valid for 60 s.

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

Tokens that will never work again are pruned, and the result carries the
provider's reason in `error`:

- APNs `410 Unregistered`, and `400 BadDeviceToken` — which also means a valid
  token sent to the wrong environment. That is the usual cause: a TestFlight or
  App Store build registered as `sandbox`. The reason says so.
- FCM `UNREGISTERED`, `SENDER_ID_MISMATCH` (a token from another Firebase
  project), and `INVALID_ARGUMENT` when FCM names `message.token`. An
  `INVALID_ARGUMENT` about the payload is a server bug and prunes nothing.

A transient failure (a 503, a timeout) is reported as `failed` and the token is
**kept** — never prune on a transport error. A rejected credential (FCM `401`,
APNs `ExpiredProviderToken`) is re-minted and the push retried once.

APNs gets one HTTP/2 connection per host, kept open as Apple asks. An idle one
can die without a word (a NAT mapping on the path expires) and the next push
fails with `read ECONNRESET`, so a push that fails before APNs answers on a
reused connection is retried once on a new one, and the connection is pinged
every 60 s (`ApnsConfig.keepaliveMs`; an unanswered ping retires it). FCM goes
through `fetch`, which closes idle sockets after a few seconds, so it never
reuses a stale one.

### Testing the parked-caller flow

Call the park handler from a phone number pointed at it, or as a top-level call
whose own SWML is the park URL (a Calling API `dial` with
`"url": "<public>/swml/park?subscriber=<ref>"`). A REST dial or SWML `connect`
to the park resource's *Fabric address* runs the park on an internal leg
(`to: sip:steer@…`) that the API cannot end: after the device hangs up or
declines, `calling.end`, `update` with `status: completed` and the LaML Calls
update all answer `404`, and the caller stays up until its own script or
`max_duration` ends it. The server warns `Parked on an internal leg` when that
happens, and adds a `hint` to the failed end. Details in
[docs/push-setup.md](../docs/push-setup.md#testing-it-call-the-park-handler-from-a-phone-number-or-as-a-top-level-call).

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
├── core/          ← generic push service. Knows nothing about SignalWire,
│   │                except BridgeTokenStore (below).
│   ├── types.ts              Device, CallNotification, PushSender
│   ├── DeviceStore.ts        interface + in-memory + JSON file
│   ├── ApnsVoipSender.ts     PushKit
│   ├── FcmSender.ts          data-only, high priority
│   ├── NotificationService.ts  fan-out, results, token pruning
│   ├── BridgeTokenStore.ts   bridge tokens for parked SignalWire calls
│   └── jwt.ts                ES256/RS256 on node:crypto
├── routes/        ← HTTP surface. devices, notify and token are generic;
│                    swml.ts is SignalWire's parked-caller flow (SWML in and out)
├── signalwire/    ← SignalWire adapters: the webhook mapping, subscriber
│                    tokens, calling.end, request signatures
├── app.ts         ← wiring, no `listen`
└── index.ts       ← reads the environment, listens
```

The `core` / `signalwire` split is deliberate. Apart from
`BridgeTokenStore` (which holds parked SignalWire call ids, and moves with the
parked-caller flow), everything under `core/` is a standalone VoIP push
service, and the SignalWire-specific code sits in `signalwire/` and
`routes/swml.ts`. Also: `externalUserId` is not called `subscriberId` for the same
reason — one column's worth of discipline now is the difference between
multi-tenant later and a migration.

## Device registration

An app registers its own push token, so `/devices` has to know which user the
app is signed in as. Two modes, chosen by `DEVICE_AUTH`:

- **`api-token`** (default). `/devices` takes `externalUserId` from the body
  and is guarded by the shared `API_TOKEN`. That suits a backend that
  registers devices on its users' behalf, and local development with
  `API_TOKEN` unset. An app must not hold `API_TOKEN`: anyone who unzips the
  bundle could then register under any user, list every token, and push to
  anyone.
- **`caller`**. `/devices` is mounted before the `API_TOKEN` guard and calls
  `authenticateCaller`, the function `/token` already uses to decide who the
  caller is. The user it returns is the only user the request can act for:
  `POST` registers under that user (a body `externalUserId` that names anyone
  else is a `403`), `GET` lists that user's devices, and `DELETE` removes only
  that user's (another user's token is a `404`). The app authenticates exactly
  as it does for `/token`, with its own session credential.

`caller` is only as strong as `authenticateCaller`. With the development stub
(`ALLOW_UNAUTHENTICATED_TOKENS=1`) it accepts anyone as whoever the body names
(`reference`, then `externalUserId`), so it changes nothing until you replace
the stub. Without the stub and without your own function, every `/devices`
request is refused, the same closed default as `/token`.

A push token can still move between users (a reinstall, a shared handset):
the newest registration wins. Knowing a token does not make you its user,
which is why the user comes from authentication and not from the body.

## Production gaps

This is a scaffold. Before it carries real traffic:

- **Storage.** `JsonFileDeviceStore` rewrites the whole file per write and has
  no locking. Implement `DeviceStore` against Postgres.
- **Per-user auth on `/devices`.** Off by default: with `DEVICE_AUTH` unset
  the only control is the shared `API_TOKEN`, which an app cannot hold without
  shipping it in its bundle, and whoever can call `/devices` can register a
  device under any user — and so receive that user's calls and bridge tokens —
  list every token, and delete anyone's. Set `DEVICE_AUTH=caller` and replace
  `authenticateCaller` (see [Device registration](#device-registration)).
- **Cancelling a ring.** Nothing tells a user's other devices that one of them
  answered or declined, or that the parked caller hung up: they ring until the
  client's own timeout.
- **Respond then send.** Pushes run inline so failures are visible while you
  wire things up; `/swml/park` waits at most 5 s for them. Under load, enqueue
  and return immediately — every second costs the caller a second of ringing.
- **Retries.** None. A 503 from APNs is reported and dropped.
- **Observability.** Delivery results are logged and returned but not stored.
  Persisting them is what makes "did the call ever reach the device?"
  answerable.

## Tests

```bash
npm test -w @signalwire/rn-push-server        # node:test, no network
npm run type-check -w @signalwire/rn-push-server   # tests included
```

The suite needs no Apple or Google credentials. `ApnsVoipSender` runs its real
HTTP/2 client against an in-memory `node:http2` server, and `FcmSender` against
a fake `fetch` playing Google's OAuth and FCM endpoints. The JWT tests use
freshly generated key pairs and assert the two things that produce unhelpful
403s in production: ES256 with the key id in the header, and a 64-byte JOSE
signature rather than DER. The signature tests use the vectors from
SignalWire's SDK documentation.

## Subscriber tokens

```
POST /token  ->  { token, reference, expires_at }
```

Mints a Fabric subscriber token so the app never holds project credentials. A
subscriber token is short-lived and scoped to one subscriber; the project ID and
API token that mint it are neither, and anyone who unzips an IPA containing them
could mint tokens for every subscriber in the space.

Each token is minted with `expire_at` set `TOKEN_TTL_SECONDS` ahead (default
7200, at least 60), and the response's `expires_at` (Unix seconds) says when it
ends, so the app's `fetchToken` can renew it in time (see `docs/tokens.md`).

```bash
SIGNALWIRE_SPACE=example.signalwire.com \
SIGNALWIRE_PROJECT_ID=<project-id> \
SIGNALWIRE_API_TOKEN=<api-token> \
ALLOW_UNAUTHENTICATED_TOKENS=1 \
DEV_SUBSCRIBER_REFERENCE=rn-example \
npm run dev -w @signalwire/rn-push-server

curl -X POST localhost:3000/token -H 'content-type: application/json' -d '{}'
```

`/token` sits **outside** the shared `API_TOKEN` guard, because the app calls it
directly and cannot hold that secret. It carries its own auth instead:
`authenticateCaller` in `src/routes/token.ts` maps an incoming request to a
subscriber reference. **That function is the seam you replace** — real
deployments send their own session credential and look up the user.

`ALLOW_UNAUTHENTICATED_TOKENS=1` swaps in a stub that accepts anyone, and the
server logs a warning at boot while it is on. Without it, and without your own
`authenticateCaller`, every request is rejected — a closed default, because the
open one mints tokens for arbitrary subscribers.

The client never chooses its own reference when auth supplies one: whoever picks
the reference picks whose calls they receive.
