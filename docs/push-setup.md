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
| 8 | Native PushKit hook (generated) | [1d](#1d-the-native-pushkit-hook--generated-for-you) | CallKit UI appears with the app force-quit |
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

### 1d. The native PushKit hook — generated for you

**This is the step that cannot be skipped or moved to JS.** On a cold start the
JS bundle is not running when the push arrives. Since iOS 13, if you do not
report the call to CallKit *in the same callback*, the OS terminates your app
and eventually stops delivering VoIP pushes to it entirely.

**With Expo, the config plugin now generates it.** `enableVoipPush` (the
default) writes `SignalWireVoipPush.m` into the iOS project and adds it to the
compile sources. It registers a `PKPushRegistry`, reports incoming pushes
straight to CallKit, and bridges the device token to JavaScript. Nothing to add
by hand, and `expo prebuild` regenerates it rather than clobbering it.

It is an Objective-C category rather than a patch to `AppDelegate.swift` for
two reasons: regex-patching Expo's Swift template fails silently whenever the
template changes, and Swift cannot `import RNCallKeep` at all — callkeep's
podspec does not expose a consumable Swift module
([callkeep#856](https://github.com/react-native-webrtc/react-native-callkeep/issues/856)).

Verify it landed:

```bash
npm run verify:prebuild    # asserts the file is generated AND compiled
```

A generated `.m` that Xcode does not compile is silently ignored, and the
failure only shows up much later as "pushes do nothing" — which is why the
check asserts the `pbxproj` reference, not just the file.

**Bare React Native** projects add the equivalent by hand. Copy the source from
`packages/react-native/src/plugin/voipPushSource.ts` into your app target; it
has no Expo dependencies.

### 1d-bis. Registering the device token

The generated module exposes the PushKit token to JS:

```ts
import { watchVoipToken } from '@signalwire/react-native/callkit';

watchVoipToken((token) => {
  void fetch(`${SERVER}/devices`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      externalUserId: subscriberReference,  // MUST match the token's reference
      platform: 'ios',
      token,
      environment: 'sandbox'                // development builds are sandbox
    })
  });
});
```

Two ways to get this wrong, both silent:

- **`externalUserId` must be the subscriber reference the SignalWire token was
  minted for.** The server looks devices up by exactly that key; a mismatch
  sends the push to someone else's device, or nobody's.
- **`environment` must match how the app was signed.** A development build is
  sandbox. Sending a sandbox token to production APNs (or the reverse) fails at
  Apple with a device-token mismatch, which reads like a bad token rather than
  a wrong environment.

`watchVoipToken` fires once with the token cached during launch — iOS issues it
before React Native has a bridge, so waiting only for the change event would
miss the first run after install — and again on every reissue.

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

Android has no PushKit. You send a **high-priority FCM data message**, and the
app builds the call UI itself — because a self-managed ConnectionService gets
none from the system. Everything below is verified on an Android 16 emulator,
hot and cold.

### 2a. Version ceiling — read this before installing

`@react-native-firebase` **v23 and later require the New Architecture.** This
package targets the legacy architecture, which the WebRTC stack still needs, so
**v22.4.0 is the last usable line**:

```bash
npm install @react-native-firebase/app@22 @react-native-firebase/messaging@22
```

Install v23+ and Gradle fails with:

```
Gradle build daemon disappeared unexpectedly (it may have been killed or may have crashed)
```

which reads like an out-of-memory kill. The real message —
`New Architecture support is required for @react-native-firebase/app` — appears
only in `~/.gradle/daemon/*/daemon-*.out.log`.

Versions below 22 predate the modular API this package calls, so the supported
range is `>=22.0.0` and, on legacy architecture, `<23`.

### 2b. Firebase project

1. Create a Firebase project, add an **Android** app with your package name.
2. Download `google-services.json`.
3. Point Expo at it. Keep it out of the repository — it is per-project:

   ```js
   // app.config.js
   android: {
     googleServicesFile: process.env.GOOGLE_SERVICES_JSON
   }
   ```

4. For the server, generate a **service account key**: Project settings →
   Service accounts → *Generate new private key*. Its `project_id`,
   `client_email` and `private_key` become `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`
   and `FCM_PRIVATE_KEY`. That key can send as your whole project — treat it
   like a password.

> **A wrinkle worth knowing.** Firebase's Expo plugin demands an iOS
> `GoogleService-Info.plist` whenever it is applied, even for an Android-only
> setup and even when prebuilding iOS, which uses PushKit and no Firebase at
> all. Either add an iOS app in Firebase purely to obtain that file, or apply
> the plugin conditionally, as `example/app.config.js` does.

### 2c. Register the token

`watchPushToken` returns whichever token this platform issues, so no platform
branch is needed. Getting that branch wrong is silent: the device registers
under the wrong platform, the server picks the wrong sender, and the push
simply never arrives.

```ts
import { watchPushToken } from '@signalwire/react-native/callkit';

watchPushToken(({ platform, token }) => {
  void fetch(DEVICES_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ externalUserId, platform, token })
  });
});
```

`environment: 'sandbox'` is APNs-only; FCM has no sandbox/production split.

### 2d. Handle the push

Call this from your entry file, **outside React**. Android delivers to two
different places depending on whether the app is alive, and registering only
one of them looks like flakiness — calls arrive when the app happens to be
open and vanish when it is not.

```js
// index.js
import { registerAndroidCallPush } from '@signalwire/react-native/callkit';

registerAndroidCallPush();   // no-op on iOS and without Firebase installed
```

That wires `setBackgroundMessageHandler` (a headless task, used when the app is
killed — the normal case for an incoming call) and `onMessage` (foreground,
where the background handler never fires), reports the call to
ConnectionService, and brings the app forward.

### 2e. Draw the call yourself

**Android shows no incoming-call UI.** callkeep is registered self-managed, so
Telecom tracks the call and draws nothing — by design. Without a sheet of your
own, the push lands, a connection exists, and the user sees nothing at all.

The kit's component handles both sources, and defaults to including native
pushes on Android and not on iOS, where CallKit already drew the call:

```tsx
import { IncomingCallSheet } from '@signalwire/react-native-ui';

<IncomingCallSheet onAnswered={setCall} />
```

Rolling your own? Use `useRingingPushes` from
`@signalwire/react-native/ringing` — a separate entry point, because the
`./callkit` barrel pulls in `react-native-callkeep`, which builds a
`NativeEventEmitter` at import time and would make an optional peer mandatory.

### 2f. Permissions

The config plugin declares what is needed, but two things need doing at
runtime:

- **`READ_PHONE_NUMBERS` must be granted, not merely declared.** callkeep's
  ConnectionService reads the phone account while building an outgoing
  connection. Ungranted, the call connects and *then* the app dies with
  `SecurityException` inside `VoiceConnectionService.createConnection` — which
  reads as a crash on answer rather than a missing grant. This package requests
  it during `setup()`.
- **`POST_NOTIFICATIONS`** (Android 13+) for anything you want to show.

The plugin also declares callkeep's `VoiceConnectionService` with
`android:permission="android.permission.BIND_TELECOM_CONNECTION_SERVICE"`.
callkeep ships permissions only, and without that declaration Telecom refuses
the phone account and the app dies on **every** launch.

### 2g. Reserved keys in the payload

FCM rejects a data payload containing `from`, `to`, `notification`,
`message_type`, `collapse_key`, or anything prefixed `google`/`gcm` — with
`400 Invalid data payload key`, failing the whole message. APNs accepts the
same payload happily, so this presents as "Android push is broken" while iOS
works, from the same call.

Send those keys prefixed (`sw_from`) and map them back on the device;
`decodePushData` in this package does exactly that, and the example server
shows the sending half.

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

---

## Appendix: the parked-caller inbound flow

The straightforward design — SignalWire dials the subscriber, a push wakes the
device, the invite arrives — loses a race it cannot win. A device woken by push
needs several seconds to launch, fetch a token, open a WebSocket and
authenticate; an invite arriving before that fails, and cold start is precisely
the case push exists for.

Parking the caller removes the race instead of tuning it:

```
1. inbound call ──▶ SWML: POST <public>/swml/park
2. server: mint a single-use token for the call SID, push it, answer + ringback
3. device wakes; CallKit rings before any JavaScript exists
4. user answers ──▶ app dials <bridge address>?bridgeToken=…
5. SWML: POST <public>/swml/bridge  ──▶ { connect: { to: "call:<sid>" } }
6. bridged
```

The caller hears ringback throughout, so the wait is invisible, and the device
joins whenever it is ready — there is no deadline to miss.

### Why a token and not the call SID

The push carries an opaque token. A payload containing the SID is a
**capability**: anyone replaying it could bridge into the call. A token is
single-use, expires in 60s and is bound to one subscriber, so redemption is a
decision the server makes rather than a fact the device asserts.

`/swml/bridge` sits outside the API-token guard, because SignalWire fetches it
and cannot present that secret — it authorises on the token alone. Losing the
subscriber check would let any subscriber holding a token join any parked call.

### What each side does

| Piece | Where |
| --- | --- |
| Park, mint, push | `server/src/routes/swml.ts` |
| Token lifetime and authorisation | `server/src/core/BridgeTokenStore.ts` |
| Forward opaque payload to JS | generated `SignalWireVoipPush.m` |
| Adopt the natively-displayed entry | `CallKeepBridge` / `CallRegistry.adoptNativeEntry` |
| Ask the app to dial | `CallRegistry.answerRequested$` |
| Attach the placed call | `CallRegistry.bindCall` |
| Example wiring | `example/src/useBridgeAnswer.ts` |

### Running it

```bash
tailscale funnel 3000        # or ngrok http 3000 — SignalWire must reach you
PUBLIC_URL=https://<host>.ts.net npm run dev -w @signalwire/rn-push-server
```

Then create a SignalWire resource whose SWML handler is `<public>/swml/park`,
and point `EXPO_PUBLIC_SW_BRIDGE_ADDRESS` at an address whose handler is
`<public>/swml/bridge`.

### Pointing a phone number at it

Set `PARK_ROUTES` so the number resolves to a subscriber:

```bash
PARK_ROUTES=+15551234567:rn-example
```

Without it the resolver falls back to the last path segment of the dialled
destination, which for a number is the number — the push is addressed to a
subscriber that does not exist and reports `delivered: 0` with no error. That
exact mistake happened here with the park resource's own name, which is why the
fallback is now last rather than first.

The caller ID is read from the call params and shown on the lock screen, so a
real number appears as itself rather than "Unknown".

**Still unverified:** the exact request shape SignalWire sends to a SWML
handler. `callSidFrom` and `calledAddressFrom` accept several plausible field
names and the handler logs the whole body — point a real call at it, read the
log, then delete the guesses. The `ring:2:us` fallback for ringback is likewise
from memory; set `PUBLIC_URL` and serve your own audio if it is wrong.
