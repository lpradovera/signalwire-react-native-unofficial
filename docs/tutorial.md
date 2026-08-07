# Tutorial: a calling app, from nothing to a ringing phone

Builds a React Native app that places and receives calls, with native call UI
on both platforms. About an hour, most of it waiting for builds.

Written to be followed in order. Each stage ends with something you can
actually observe, because a calling app has many silent failure modes and
finding out at stage 6 that stage 2 was wrong is miserable.

**You need:** Node 20+, a SignalWire account, and Xcode (iOS) or Android Studio
(Android). A physical iPhone or iPad for iOS push — the simulator has no
PushKit worth trusting.

---

## 1. Create the app

```bash
npx create-expo-app@latest my-calling-app --template blank-typescript
cd my-calling-app
npx expo install expo-dev-client
```

This package needs native modules, so **Expo Go will not work** — you build a
dev client. That is what `expo-dev-client` is for.

```bash
npm install @signalwire/react-native @signalwire/js rxjs \
  react-native-webrtc \
  @react-native-async-storage/async-storage \
  react-native-get-random-values \
  react-native-url-polyfill \
  react-native-callkeep react-native-incall-manager
```

The last two are optional peers, but you want native call UI and audio routing,
so install them now.

Add the config plugin to `app.json`:

```json
{
  "expo": {
    "plugins": [
      "expo-dev-client",
      "@config-plugins/react-native-webrtc",
      ["@signalwire/react-native", { "enableCallKit": true, "enableVoipPush": true }]
    ],
    "ios": { "bundleIdentifier": "com.example.mycallingapp" },
    "android": { "package": "com.example.mycallingapp" }
  }
}
```

The plugin writes the permissions, entitlements, background modes and the
native push hook. Without it you get to do all of that by hand, and the
failures are quiet — a missing `aps-environment` entitlement, for instance,
still lets the app register for push and still reports every send as delivered.

## 2. Polyfills first — genuinely first

Create `index.js` and set it as `"main"` in `package.json`:

```js
// index.js
import '@signalwire/react-native/polyfills';   // MUST be line 1

import { registerRootComponent } from 'expo';

import App from './App';

registerRootComponent(App);
```

The browser SDK dispatches a `CustomEvent` on `window` at import time, parses
dial strings with `new URL()`, and generates UUIDs with `crypto`. React Native
has none of those. Import anything from `@signalwire/js` before the polyfills
and you get a crash at startup that names none of this.

**Checkpoint:** `npx expo run:ios` (or `run:android`) builds and the app opens
to the Expo template screen. If it crashes at launch, the polyfill import is in
the wrong place.

## 3. Get a token — from your server, not the client

The SDK authenticates with a **Subscriber Access Token**. Minting one needs
your SignalWire API credentials, which must never ship in an app: anyone can
read them out of a bundle.

So you need a small backend. `server/` in this repository is a working example
— roughly 40 lines for the token endpoint:

```ts
// POST /token  ->  { token }
app.post('/token', async (req, res) => {
  const user = await authenticateYourUser(req);   // your auth, not ours
  const token = await mintSubscriberToken(user.id);
  res.json({ token });
});
```

The important part is the first line: **you** decide who the caller is. The
example server ships with `ALLOW_UNAUTHENTICATED_TOKENS=1` so it mints for
anyone, which is fine on a laptop and a disaster in production.

## 4. Connect

```tsx
// App.tsx
import { SignalWireProvider, useSignalWire } from '@signalwire/react-native';
import { useEffect, useMemo, useState } from 'react';
import { Button, Text, View } from 'react-native';

import type { CredentialProvider } from '@signalwire/js';

function Dialer() {
  const { isConnected, user, dial } = useSignalWire();
  return (
    <View>
      <Text>{isConnected ? `Online as ${user?.displayName}` : 'Connecting…'}</Text>
      <Button title="Call" onPress={() => void dial('/public/your-resource', {
        audio: true,
        video: false
      })} />
    </View>
  );
}

export default function App() {
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    void fetch('http://localhost:3000/token', { method: 'POST' })
      .then((r) => r.json())
      .then((body) => setToken(body.token));
  }, []);

  const credentials = useMemo<CredentialProvider | null>(
    () => (token ? { getToken: async () => token } : null),
    [token]
  );

  if (!credentials) return <Text>Loading…</Text>;

  return (
    <SignalWireProvider credentialProvider={credentials}>
      <Dialer />
    </SignalWireProvider>
  );
}
```

`credentialProvider` is memoised deliberately: the provider rebuilds its client
whenever that value changes, and an inline object literal is a new value on
every render.

**Checkpoint:** the app says "Online as …". If it says "Connecting…" forever,
your token endpoint is the first thing to check — on Android an emulator cannot
resolve your Mac's hostname, so use `adb reverse tcp:3000 tcp:3000` and
`http://localhost:3000`.

## 5. Place a call, with audio

`audio: true, video: false` above is not decoration. An SDP answer cannot
introduce a media line the offer lacks, so offering video to an audio-only
destination produces a call that is accepted and then never answers — which
looks like a network problem and is not.

Render the call:

```tsx
import { useCall } from '@signalwire/react-native';

function ActiveCall({ call, onEnded }) {
  const { status, hangup, setAudioMuted } = useCall(call);
  return (
    <View>
      <Text>{status}</Text>
      <Button title="Mute" onPress={() => void setAudioMuted(true)} />
      <Button title="End" onPress={() => void hangup().then(onEnded)} />
    </View>
  );
}
```

**Checkpoint:** you can hear the far end. On an Android emulator, in-call volume
defaults to about 3 of 15 and can only be changed *while a call is up* — silence
here is usually that, not your code.

## 6. Native call UI

```js
// index.js, after the polyfills
import { getCallKit, registerAndroidCallPush } from '@signalwire/react-native/callkit';

void getCallKit().setup({ appName: 'My Calling App', supportsVideo: false });
registerAndroidCallPush();
```

Both go in the entry file, outside React: a VoIP push can wake a killed app
before any component mounts, and the call has to be reported to the OS before
that happens.

Then mount the incoming-call sheet:

```tsx
import { IncomingCallSheet } from '@signalwire/react-native-ui';

<IncomingCallSheet onAnswered={setCall} />
```

On iOS, CallKit draws the call itself — on the lock screen, over other apps —
and this sheet covers the foreground case. **On Android nothing is drawn for
you**: a self-managed ConnectionService is tracked by the system but rendered
by you, so without this component a pushed call is invisible.

## 7. Push

Follow [push-setup.md](./push-setup.md) — it is long because push has more
silent failure modes than the rest of the SDK combined. The shortest useful
summary:

- **iOS:** an APNs key (`.p8`), a server that signs a JWT with it, and the
  `aps-environment` entitlement. The config plugin adds the entitlement; without
  it iOS still issues a token and APNs still reports `delivered`, and nothing
  arrives.
- **Android:** Firebase, `@react-native-firebase` **v22** (v23+ needs the New
  Architecture), a high-priority **data** message, and `registerAndroidCallPush()`.

Register the device token wherever your app knows who the user is:

```ts
import { watchPushToken } from '@signalwire/react-native/callkit';

watchPushToken(({ platform, token }) => {
  void fetch(`${SERVER}/devices`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ externalUserId: user.id, platform, token })
  });
});
```

**Checkpoint:** your server can push and the phone rings with the app closed.

## 8. Answering an inbound call

Here is the part most designs get wrong, so it is worth stating plainly.

A device woken by push needs several seconds to launch, fetch a token, open a
WebSocket and authenticate. An invite that arrives before that simply fails —
and cold start is the case push exists for.

So do not dial the device. **Park the caller and let the device come to you:**

1. The caller reaches your server's SWML: answer, play ringback, and push the
   device with a **single-use token** — not the call SID, which is a capability
   anyone replaying the push could spend.
2. The device wakes, shows the call, and when the user answers it dials your
   bridge endpoint with that token.
3. Your server redeems the token and connects the two legs.

The appendix in [push-setup.md](./push-setup.md#appendix-the-parked-caller-inbound-flow)
has the SWML. `server/src/routes/swml.ts` is a working implementation, and
`example/src/useBridgeAnswer.ts` is the device half.

**Checkpoint:** call in, answer on a killed phone, talk both ways, and hang up
from either end.

---

## When it does not work

[TESTING.md](../TESTING.md) has a triage table of every failure encountered
building this, with the symptom, the cause, and the fix. The ones that cost the
most time:

| Symptom | Almost always |
| --- | --- |
| A fix "does nothing" on device | Metro served a cached bundle. `iOS Bundled 42ms (1 module)` is the tell; a real bundle is ~1200 modules |
| Push reports `delivered`, nothing arrives | Missing `aps-environment`, or a token from a different install |
| `Call create timeout` in a browser | An unanswered microphone prompt — the SDK takes media before sending the invite |
| Android app dies just after connecting | `READ_PHONE_NUMBERS` declared but not granted |
| Everything works, no audio | Check the OS volume for the *voice-call* stream before suspecting the SDK |
