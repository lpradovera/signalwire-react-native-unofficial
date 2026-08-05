# Setting up push notifications

End-to-end instructions for waking a killed app for an inbound SignalWire call.

This is the largest single piece of integration work in the project, and almost
all of it lives outside this package. Budget for it accordingly.

---

## 0. What you are building

**SignalWire has no push infrastructure.** There is no device-token endpoint and
it will not send a push when a call arrives. Every link below is yours:

```
  ┌──────────────┐  1. inbound call    ┌──────────────┐
  │  SignalWire  │────── webhook ─────▶│ your backend │
  └──────────────┘                     └──────┬───────┘
                                              │ 2. look up device token
                                              │    for the callee
                                              ▼
                              ┌───────────────────────────┐
                              │  APNs (VoIP)  /  FCM      │
                              └─────────────┬─────────────┘
                                            │ 3. push carrying call_id
                                            ▼
  ┌──────────────────────────────────────────────────────────┐
  │  device                                                  │
  │   iOS:     PushKit → AppDelegate → reportNewIncomingCall  │  ← native, before JS
  │   Android: FCM data → headless task                       │
  │              │                                            │
  │              ▼                                            │
  │   getCallKit().reportIncomingPush({ callId, from, ... })  │  ← the only contract
  │              │                                            │        with this package
  │              ▼                                            │
  │   CallRegistry: pending-push ──fuse──▶ fused              │
  └──────────────────────────────────────────────────────────┘
```

Four things to build:

| # | Piece | Where |
| --- | --- | --- |
| 1 | Token registration — app sends its push token to your backend | app + backend |
| 2 | The trigger — backend learns a call is inbound | backend |
| 3 | The sender — backend sends an APNs VoIP or FCM push | backend |
| 4 | The receiver — app handles the push and calls `reportIncomingPush` | app |

Pick a vendor first — see [Choosing a push vendor](native-setup.md#choosing-a-push-vendor).
This guide shows the direct APNs/FCM route, which is the one everything else
wraps.

### The order to do it in

Each step is verifiable on its own. Doing them out of order is what makes push
feel impossible to debug — you end up with three unproven links and one symptom.

| # | Step | Section | Done when |
| --- | --- | --- | --- |
| 1 | Apple: App ID capability + `.p8` key | [1a](#1a-apple-developer-portal) | You have the `.p8`, Key ID and Team ID |
| 2 | Xcode: Push + Background Modes (VoIP, Audio) | [1b](#1b-xcode-capabilities) | Capabilities show in the project |
| 3 | Firebase: project + `google-services.json` | [2a](#2a-firebase) | File is in `android/app/` |
| 4 | App: acquire tokens | [1c](#1c-app-register-for-pushkit-and-report-the-token), [2b](#2b-app-report-the-fcm-token) | You can log a token on each platform |
| 5 | App: upload tokens to your server | [3](#3-app-sending-the-token-to-your-server) | `GET /devices` lists them |
| 6 | Server: senders configured | [4b](#4b-sending-an-apns-voip-push), [4c](#4c-sending-an-fcm-data-message) | Startup logs no "not configured" warning |
| 7 | Send a push by hand, app in foreground | [5](#5-verifying-it-one-link-at-a-time) | `POST /notify` reports `delivered: 1` |
| 8 | `AppDelegate` PushKit hook | [1d](#1d-appdelegate-report-to-callkit-before-javascript-boots) | CallKit UI appears with the app force-quit |
| 9 | JS receives and reports | [1e](#1e-js-pick-the-call-up-from-callkeep), [2c](#2c-app-the-headless-background-handler) | `reportIncomingPush` is called |
| 10 | Fusion | [5](#5-verifying-it-one-link-at-a-time) | Logs show `Fused call … into …` |
| 11 | The trigger (webhook) | [4d](#4d-the-trigger) | A real inbound call pushes automatically |

Steps 1–7 need no app changes beyond token upload and can be proven with `curl`.
Step 8 is the one that cannot be skipped or moved into JavaScript.

### The payload contract

Whatever you send **must** carry the SignalWire call id. `CallRegistry` fuses
the native call entry to the SDK call by matching on it.

```json
{
  "call_id": "b8f3…",
  "from": "+15551234567",
  "from_name": "Ada Lovelace",
  "uuid": "5C1E9F…"
}
```

- `call_id` — **required.** Without it the registry falls back to "the single
  unmatched inbound call within 20 seconds" and logs a warning. That breaks the
  moment two calls overlap.
- `uuid` — iOS only. Generate it **on the backend** so the native `AppDelegate`
  hook and the JS side agree on one identifier. Any RFC 4122 v4 UUID.
- `from` / `from_name` — what the native call UI displays. Optional; the
  registry substitutes "Unknown".

Keep the payload under 4 KB (APNs limit). VoIP pushes have no user-visible part.

---

## 1. iOS

### 1a. Apple Developer portal

1. **Identifiers → your App ID → Capabilities**: enable **Push Notifications**.
2. **Keys → +**: create a key with **Apple Push Notifications service (APNs)**
   enabled. Download the `.p8` — *you can only download it once*. Note the
   **Key ID** and your **Team ID**.

   One `.p8` key covers **both** alert and VoIP pushes, and both sandbox and
   production. This is why token auth beats certificates: the alternative is a
   separate VoIP Services `.p12` that expires annually.

   (If your push vendor requires a `.p12` — OneSignal does — create a **VoIP
   Services Certificate** instead, under Certificates → +.)

### 1b. Xcode capabilities

In **Signing & Capabilities** add:

- **Push Notifications**
- **Background Modes** → tick **Voice over IP** and **Audio, AirPlay, and Picture
  in Picture**

With Expo, the config plugin already writes the `UIBackgroundModes` array
(`audio` + `voip`); confirm it survived `expo prebuild`.

### 1c. App: register for PushKit and report the token

```bash
npm install react-native-voip-push-notification
```

```ts
// src/push/ios.ts
import VoipPushNotification from 'react-native-voip-push-notification';

export function registerVoipPush(uploadToken: (token: string) => Promise<void>): void {
  VoipPushNotification.addEventListener('register', (token: string) => {
    // NOTE: this is the PushKit token. It is NOT the same as the APNs alert
    // token from expo-notifications or @react-native-firebase/messaging.
    void uploadToken(token);
  });

  VoipPushNotification.registerVoipToken();
}
```

Call it once the user is authenticated, and re-upload whenever it changes —
tokens rotate on reinstall, restore, and occasionally at the OS's discretion.

### 1d. AppDelegate: report to CallKit before JavaScript boots

**This is the step that cannot be skipped or moved to JS.** On a cold start the
JS bundle is not running when the push arrives. Since iOS 13, if you do not
report the call to CallKit *in the same callback*, the OS terminates your app
and eventually stops delivering VoIP pushes to it entirely.

Objective-C `AppDelegate.mm`:

```objc
#import <PushKit/PushKit.h>
#import "RNCallKeep.h"

- (void)pushRegistry:(PKPushRegistry *)registry
didReceiveIncomingPushWithPayload:(PKPushPayload *)payload
             forType:(PKPushType)type
withCompletionHandler:(void (^)(void))completion
{
  NSDictionary *data = payload.dictionaryPayload;
  NSString *uuid       = data[@"uuid"];
  NSString *callId     = data[@"call_id"];
  NSString *handle     = data[@"from"] ?: @"Unknown";
  NSString *callerName = data[@"from_name"] ?: @"Unknown caller";

  [RNCallKeep reportNewIncomingCall:uuid
                             handle:handle
                         handleType:@"generic"
                           hasVideo:NO
                localizedCallerName:callerName
                    supportsHolding:YES
                       supportsDTMF:YES
                   supportsGrouping:NO
                 supportsUngrouping:NO
                        fromPushKit:YES
                            payload:@{@"callId": callId ?: @"", @"uuid": uuid ?: @""}
              withCompletionHandler:completion];
}
```

Expo SDK 52 generates a **Swift** `AppDelegate`. Either add the Swift equivalent
or drop in a small Objective-C category. The config plugin deliberately does not
patch this file: regex-patching Swift source fails silently, which is worse than
not generating it.

### 1e. JS: pick the call up from callkeep

The native hook already showed the CallKit UI. JS then tells the registry about
it, so the SDK call can fuse:

```ts
// index.js, after the polyfills import
import { getCallKit } from '@signalwire/react-native/callkit';
import RNCallKeep from 'react-native-callkeep';

RNCallKeep.addEventListener('didDisplayIncomingCall', ({ payload }) => {
  getCallKit().reportIncomingPush({
    callId: payload?.callId,
    from: payload?.from,
    fromName: payload?.from_name
  });
});
```

---

## 2. Android

Android has no PushKit equivalent. You send a **high-priority FCM data message**
and build the call UI yourself — which is what `CallKeepBridge` already does via
ConnectionService.

### 2a. Firebase

1. Create a Firebase project and add an Android app with your package name
   (`com.signalwire.rnexample` in the example).
2. Download `google-services.json` into `android/app/`.
3. With Expo, add it to `app.json`:
   ```json
   { "expo": { "android": { "googleServicesFile": "./google-services.json" } } }
   ```

```bash
npm install @react-native-firebase/app @react-native-firebase/messaging
```

### 2b. App: report the FCM token

```ts
// src/push/android.ts
import messaging from '@react-native-firebase/messaging';

export async function registerFcmPush(
  uploadToken: (token: string) => Promise<void>
): Promise<void> {
  await messaging().requestPermission();
  await uploadToken(await messaging().getToken());
  messaging().onTokenRefresh((token) => void uploadToken(token));
}
```

### 2c. App: the headless background handler

Registered at module scope, **not** inside a component — a killed app has no
component tree:

```js
// index.js, after the polyfills import
import messaging from '@react-native-firebase/messaging';
import { getCallKit } from '@signalwire/react-native/callkit';

messaging().setBackgroundMessageHandler(async (message) => {
  const { call_id: callId, from, from_name: fromName } = message.data ?? {};
  getCallKit().reportIncomingPush({ callId, from, fromName });
});
```

### 2d. Android 14+

Starting a foreground service from the background is restricted. For a locked
device, present the call with a **full-screen intent**
(`USE_FULL_SCREEN_INTENT`) rather than relying on a foreground-service start.
callkeep's self-managed ConnectionService mode handles this when configured —
see its Android setup guide.

---

## 3. App: sending the token to your server

Sections 1c and 2b both hand their token to an `uploadToken` callback. This is
that callback — the seam between the two halves, and the step most easily
forgotten until nothing arrives and it is not obvious why.

```ts
// src/push/register.ts
import { Platform } from 'react-native';

const PUSH_SERVER = process.env.EXPO_PUBLIC_PUSH_SERVER ?? 'http://localhost:3000';

/** Whether this build talks to APNs sandbox. Dev builds do; TestFlight and App Store do not. */
const APNS_ENVIRONMENT = __DEV__ ? 'sandbox' : 'production';

export async function uploadToken(externalUserId: string, token: string): Promise<void> {
  const response = await fetch(`${PUSH_SERVER}/devices`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.EXPO_PUBLIC_PUSH_API_TOKEN ?? ''}`
    },
    body: JSON.stringify({
      externalUserId,
      platform: Platform.OS,
      token,
      environment: APNS_ENVIRONMENT
    })
  });

  if (!response.ok) {
    throw new Error(`Token registration failed: ${response.status} ${await response.text()}`);
  }
}
```

Then wire both platforms up once the user is authenticated — you need the
`externalUserId` first, so this cannot happen at app launch:

```ts
// src/push/index.ts
import { Platform } from 'react-native';

import { registerFcmPush } from './android';
import { registerVoipPush } from './ios';
import { uploadToken } from './register';

export function registerForCalls(externalUserId: string): void {
  const upload = (token: string) => uploadToken(externalUserId, token);

  if (Platform.OS === 'ios') {
    registerVoipPush(upload);
  } else {
    void registerFcmPush(upload);
  }
}
```

Three things worth getting right here:

- **Re-upload on every launch, not just first run.** Tokens rotate on reinstall,
  restore from backup, and occasionally at the OS's discretion. `POST /devices`
  is idempotent — it overwrites by token — so calling it every launch is cheap
  and closes the staleness gap.
- **`environment` must match the build.** A development build registers against
  APNs sandbox; TestFlight and App Store builds are production. Sending a
  sandbox token to the production host returns `BadDeviceToken`, and this is the
  single most common reason a correctly-written push never arrives.
- **Unregister on sign-out** with `DELETE /devices/:token`, or the next person
  to use the handset gets a call meant for someone else.

The server in [`../server/`](../server/) implements this endpoint. To try the
whole chain locally:

```bash
API_TOKEN=devsecret npm run dev -w @signalwire/rn-push-server
```

Point `EXPO_PUBLIC_PUSH_SERVER` at it — for a physical device, that means your
machine's LAN address rather than `localhost`.

---

## 4. Your backend

A working implementation of everything in this section is in [`../server/`](../server/) —
token registry, both senders, fan-out with token pruning, and the webhook
adapter. Read on for what it is doing and why; run `npm run dev -w
@signalwire/rn-push-server` to start it.

### 4a. Store tokens

Minimum viable schema:

| Column | Notes |
| --- | --- |
| `subscriber_id` | The SignalWire subscriber this device belongs to |
| `platform` | `ios` \| `android` |
| `token` | PushKit token (iOS) or FCM token (Android) |
| `environment` | `sandbox` \| `production` — iOS only, and they are not interchangeable |
| `updated_at` | For pruning stale tokens |

One subscriber can have many devices. Push to all of them and let the first
answer win; the registry ends the others as missed.

### 4b. Sending an APNs VoIP push

The whole sender, using the `.p8` key:

```js
// backend/apns.js
import http2 from 'node:http2';
import jwt from 'jsonwebtoken';

const KEY_ID = process.env.APNS_KEY_ID;
const TEAM_ID = process.env.APNS_TEAM_ID;
const BUNDLE_ID = process.env.IOS_BUNDLE_ID;
const P8 = process.env.APNS_P8_KEY;         // contents of the .p8 file

let cachedToken = null;
let cachedAt = 0;

/** Apple rejects tokens older than 1h and refuses regeneration under 20 min. */
function bearerToken() {
  const now = Date.now();
  if (cachedToken && now - cachedAt < 30 * 60 * 1000) {
    return cachedToken;
  }
  cachedToken = jwt.sign({ iss: TEAM_ID, iat: Math.floor(now / 1000) }, P8, {
    algorithm: 'ES256',
    header: { alg: 'ES256', kid: KEY_ID }
  });
  cachedAt = now;
  return cachedToken;
}

export async function sendVoipPush({ deviceToken, sandbox, payload }) {
  const host = sandbox ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
  const client = http2.connect(host);

  try {
    const body = JSON.stringify(payload);
    const request = client.request({
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      authorization: `bearer ${bearerToken()}`,
      'apns-topic': `${BUNDLE_ID}.voip`,   // NOTE the .voip suffix
      'apns-push-type': 'voip',            // required; Apple rejects without it
      'apns-priority': '10',
      'apns-expiration': '0',              // deliver now or discard
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body)
    });

    request.end(body);

    return await new Promise((resolve, reject) => {
      let status;
      let data = '';
      request.on('response', (headers) => (status = headers[':status']));
      request.on('data', (chunk) => (data += chunk));
      request.on('end', () =>
        status === 200 ? resolve({ ok: true }) : reject(new Error(`APNs ${status}: ${data}`))
      );
      request.on('error', reject);
    });
  } finally {
    client.close();
  }
}
```

Three things that silently break this:

- **`apns-topic` must have the `.voip` suffix.** Your plain bundle id is
  rejected for a VoIP push.
- **`apns-push-type: voip` is mandatory.** Apple rejects VoIP pushes without it.
- **Sandbox and production tokens are not interchangeable.** A development build
  registers against `api.sandbox.push.apple.com`. Sending a sandbox token to the
  production host returns `BadDeviceToken`.

### 4c. Sending an FCM data message

```js
// backend/fcm.js
import { google } from 'googleapis';

const PROJECT_ID = process.env.FCM_PROJECT_ID;

async function accessToken() {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/firebase.messaging']
  });
  return (await auth.getClient()).getAccessToken();
}

export async function sendCallPush({ deviceToken, payload }) {
  const { token } = await accessToken();

  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          token: deviceToken,
          // Data-only. Adding a `notification` block makes Android hand it to
          // the system tray instead of your background handler.
          data: {
            call_id: payload.call_id,
            from: payload.from ?? '',
            from_name: payload.from_name ?? ''
          },
          android: { priority: 'high' }
        }
      })
    }
  );

  if (!response.ok) {
    throw new Error(`FCM ${response.status}: ${await response.text()}`);
  }
}
```

`priority: 'high'` is what lets the message pierce Doze. A `notification` block
alongside `data` sends it to the system tray and your handler never runs.

### 4d. The trigger

**Confirm this part against current SignalWire documentation — it is the one
link I could not verify from the SDK source.** You need a server-side signal
that a call is inbound for a subscriber, carrying the call id, early enough to
push before the caller gives up. In SignalWire that means a webhook or Relay
application bound to the resource being dialled. Ask SignalWire support for the
current mechanism for **inbound calls to a Fabric subscriber**, and confirm the
payload includes the same call id the SDK will report on `incomingCalls$` —
fusion depends on those matching exactly.

Then:

```js
app.post('/webhooks/signalwire/inbound', async (req, res) => {
  const { call_id: callId, from, from_name: fromName, to_subscriber: subscriberId } = req.body;

  const devices = await db.devicesFor(subscriberId);

  await Promise.allSettled(
    devices.map((device) =>
      device.platform === 'ios'
        ? sendVoipPush({
            deviceToken: device.token,
            sandbox: device.environment === 'sandbox',
            payload: { call_id: callId, from, from_name: fromName, uuid: crypto.randomUUID() }
          })
        : sendCallPush({
            deviceToken: device.token,
            payload: { call_id: callId, from, from_name: fromName }
          })
    )
  );

  res.sendStatus(200);
});
```

Respond fast. Do the pushes inline only if they are quick; otherwise enqueue and
return immediately. Every second here is a second of ringing the caller loses.

---

## 5. Verifying it, one link at a time

Do **not** debug this end to end. Test each link in isolation, in this order:

1. **Token reaches your backend.** Log it on registration. iOS PushKit tokens
   are 64 hex chars; if you see an APNs *alert* token instead, you wired up the
   wrong library.
2. **The sender works, app in foreground.** Call `sendVoipPush` from a script
   with a known token. A `200` from Apple means accepted — it does not mean
   delivered. On iOS, the `AppDelegate` hook firing is the proof.
3. **App backgrounded.** Same push. CallKit UI should appear.
4. **App force-quit.** The real test. If nothing appears, it is almost always
   the missing `AppDelegate` hook or the wrong `apns-topic`.
5. **Fusion.** Confirm the SDK connects and `CallRegistry` moves the entry from
   `pending-push` to `fused`. Enable debug logging:
   `setLogLevel('debug')` from `@signalwire/js`; look for
   `[SignalWireRN] Fused call … into …`.
6. **The unfused case.** Send a push with a `call_id` that never arrives. The
   native call must end itself as missed within 20 seconds. A stuck entry in the
   iOS call log means the tick timer is not running.

Scenarios 5 to 7 in [`device-testing.md`](device-testing.md) are the hardware
versions of steps 4 to 6.

---

## 6. Troubleshooting

| Symptom | Cause |
| --- | --- |
| APNs `BadDeviceToken` | Sandbox token sent to production host, or vice versa |
| APNs `TopicDisallowed` | `apns-topic` missing the `.voip` suffix |
| APNs `403 InvalidProviderToken` | JWT older than 1h, wrong Key ID/Team ID, or malformed `.p8` |
| APNs 200 but nothing happens on device | `AppDelegate` hook missing — the most common cause by far |
| App is killed shortly after a push | You did not report to CallKit in the PushKit callback. iOS eventually stops delivering VoIP pushes entirely |
| FCM delivered but handler never runs | Payload included a `notification` block; make it data-only |
| FCM delayed by minutes | `android.priority` not set to `high` |
| Push arrives, CallKit shows, call never connects | Fusion failed — check `call_id` matches what the SDK reports. Look for the "fusion by fallback" warning in the logs |
| Stuck entry in the iOS call log | Push never fused and the deadline never fired |
| Works on one device, not another | Per-device token staleness, or OEM battery management on Android |
