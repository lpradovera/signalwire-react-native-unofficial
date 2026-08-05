# `@signalwire/react-native`

> **Unofficial.** This is a community project, not a SignalWire product, and is
> not affiliated with or endorsed by SignalWire.

React Native support for [`@signalwire/js`](https://www.npmjs.com/package/@signalwire/js) v4.
Supplies the platform adapters the browser-oriented SDK needs on mobile, an
idiomatic React API over its RxJS observables, and native call UI through
CallKit and ConnectionService.

Supports iOS 13+ and Android 8+, on React Native 0.76+ (bare or Expo).

## Packages

| Install this | If you are building | Contains |
| --- | --- | --- |
| [`@signalwire/react`](packages/react) | A **browser** app | Provider and hooks. No platform code. |
| [`@signalwire/react-native`](packages/react-native) | A **React Native** app | The above, re-exported, plus adapters, video view, CallKit and audio routing. |

The hooks are identical on both. React Native apps install one package and get
everything; browser apps install the core and skip the native weight entirely.

## Repository layout

| Path | What it is |
| --- | --- |
| [`packages/react/`](packages/react) | Universal core — provider and hooks |
| [`packages/react-native/`](packages/react-native) | React Native platform layer |
| [`example/`](example) | Expo dev-client demo app |
| [`examples/web/`](examples/web) | Vite browser demo — proves the core is universal |
| [`server/`](server) | Support server — device-token registry and APNs VoIP / FCM sender |
| [`docs/`](docs) | Native setup, push setup, device-test checklist |
| [`TESTING.md`](TESTING.md) | How to verify all of it, from a cold start |

## Install

```bash
npm install @signalwire/react-native @signalwire/js rxjs \
  react-native-webrtc \
  @react-native-async-storage/async-storage \
  react-native-get-random-values \
  react-native-url-polyfill
```

Optional, each unlocking one feature:

| Package | Unlocks |
| --- | --- |
| `react-native-callkeep` | `@signalwire/react-native/callkit` — native call UI |
| `react-native-incall-manager` | `@signalwire/react-native/audio` — speaker/earpiece/Bluetooth routing |
| `@react-native-community/netinfo` | Network-loss detection and SDK reconnection |

Importing a subpath without its peer throws `MissingPeerDependencyError`, which
names the package and the install command.

## The import-order rule

**`@signalwire/react-native/polyfills` must be the first import in your entry
file, before anything that loads `@signalwire/js`.**

```js
// index.js
import '@signalwire/react-native/polyfills';

import { registerRootComponent } from 'expo';

import App from './App';

registerRootComponent(App);
```

Three things break without it, all at import or first-call time:

- The SDK bundles `uuid`, which reads `crypto.getRandomValues`. Hermes has none.
- The SDK parses dial destinations with `new URL('destination:' + address)`.
  React Native's built-in `URL` silently drops a non-HTTP scheme, so every
  `dial()` targets the wrong address.
- The SDK's entry point dispatches a `CustomEvent` on `window` at import time,
  guarded only by `typeof window !== 'undefined'`. React Native satisfies that
  guard but provides neither `CustomEvent` nor `window.dispatchEvent`, so
  importing `@signalwire/js` throws.

`createReactNativePlatform()` verifies the polyfills ran and throws
`PolyfillNotInstalledError` naming the fix if they did not.

## Two build-config requirements

Both are consumer-side and neither is specific to Expo. You do **not** need to
change `moduleResolution` — the package ships `typesVersions`, so subpath types
resolve on Expo's stock `tsconfig.base` as well as on modern resolution.

**Metro must resolve package exports** for the `/polyfills`, `/callkit` and
`/audio` subpaths. On by default from Expo SDK 53; opt in before that:

```js
// metro.config.js
config.resolver.unstable_enablePackageExports = true;
```

**Babel must transform ES2022 static class blocks.** `@signalwire/js` ships
them in its ESM build and `babel-preset-expo` does not handle them:

```bash
npm install -D @babel/plugin-transform-class-static-block
```

```js
// babel.config.js
plugins: ['@babel/plugin-transform-class-static-block'];
```

## Quick start

```tsx
import {
  SignalWireProvider,
  SignalWireVideoView,
  useCall,
  useSignalWire
} from '@signalwire/react-native';
import { useMemo, useState } from 'react';
import { Button, View } from 'react-native';

import type { Call, CredentialProvider } from '@signalwire/js';

function Dialer() {
  const { isConnected, dial } = useSignalWire();
  const [call, setCall] = useState<Call | null>(null);
  const { status, hangup } = useCall(call);

  if (call) {
    return (
      <View style={{ flex: 1 }}>
        <SignalWireVideoView call={call} kind="remote" style={{ flex: 1 }} />
        <Button title={`End (${status})`} onPress={() => void hangup()} />
      </View>
    );
  }

  return (
    <Button
      title="Call"
      disabled={!isConnected}
      onPress={() => void dial('/public/my-room', { audio: true, video: true }).then(setCall)}
    />
  );
}

export default function App() {
  // Memoize: a new identity tears down the client and rebuilds it.
  const credentials = useMemo<CredentialProvider>(
    () => ({ authenticate: async () => ({ token: 'YOUR_SUBSCRIBER_TOKEN' }) }),
    []
  );

  return (
    <SignalWireProvider credentialProvider={credentials}>
      <Dialer />
    </SignalWireProvider>
  );
}
```

## Hooks

| Hook | Returns | Entry point |
| --- | --- | --- |
| `useSignalWire()` | `client`, `isConnected`, `isRegistered`, `user`, `directory`, `error`, `dial`, `disconnect` | `@signalwire/react-native` |
| `useCall(call)` | `status`, `participants`, `self`, `localStream`, `remoteStream`, `isAudioMuted`, `isVideoMuted`, `error`, `hangup`, `toggleHold`, `setAudioMuted`, `setVideoMuted`, `sendDigits` | `@signalwire/react-native` |
| `useIncomingCalls()` | `calls`, `answer`, `reject` | `@signalwire/react-native` |
| `useDevices()` | `audioInputs`, `videoInputs`, selection, `refresh` | `@signalwire/react-native` |
| `useObservable(obs$, initial)` | The latest value of any SDK observable | `@signalwire/react-native` |
| `useAudioRoute()` | `route`, `setRoute` | `@signalwire/react-native/audio` |

`useObservable` is built on `useSyncExternalStore`, so it is tear-free under
concurrent rendering, and it seeds from the SDK's synchronous getters rather
than flashing a default. Every hook is safe with a null call or client.

`useDevices()` has no `refresh`-free auto-update: React Native emits no
`devicechange` event, so the platform sets `skipDeviceMonitoring: true` and you
call `refresh()` yourself — typically on app foreground or when opening a picker.

## Native call UI

```ts
// index.js — before React mounts, so a cold-start VoIP push finds it ready
import { getCallKit } from '@signalwire/react-native/callkit';

void getCallKit().setup({ appName: 'My App', supportsVideo: true });
```

```tsx
<SignalWireProvider credentialProvider={credentials} callKit>
```

Then, from your own push handler:

```ts
getCallKit().reportIncomingPush({ callId, from, fromName });
```

**The push payload must carry the SignalWire call id.** `CallRegistry` fuses the
native call entry with the SDK call by matching on it. Without it, the registry
falls back to "the single unmatched inbound call within the timeout" and logs a
warning — which breaks as soon as two calls overlap.

This package does not acquire push tokens, and **SignalWire has no push
infrastructure** — it will not send the push for you. The whole chain is yours:
your backend learns an inbound call is coming (webhook), looks up the device
token, and sends the push; the app receives it and calls `reportIncomingPush`.
That call is the entire contract with this package.

A runnable support server lives in [`server/`](server/) — device-token registry,
APNs VoIP and FCM senders, and a webhook endpoint.
**[`docs/push-setup.md`](docs/push-setup.md) is the full end-to-end guide** —
Apple/Firebase setup, the `AppDelegate` hook, backend senders for APNs VoIP and
FCM, and a link-by-link verification ladder.
[`docs/native-setup.md`](docs/native-setup.md) covers vendor choice.

## Not supported, and why

| Feature | Reason |
| --- | --- |
| Screen sharing | `getDisplayMedia` does not exist on React Native. The provider omits it so the SDK correctly reports screen share as unsupported. |
| Audio level meters, noise suppression | The SDK implements these with `AudioContext`, which React Native has no equivalent for. |
| Audio output selection via `setSinkId` | No `HTMLMediaElement`. Use `useAudioRoute()` instead. |
| DPoP / client-bound SAT refresh | Needs WebCrypto RSA plus IndexedDB. The SDK degrades gracefully; supply `refresh()` on your `CredentialProvider`. |

## Troubleshooting

**`PolyfillNotInstalledError`** — `@signalwire/react-native/polyfills` is missing
or not first in your entry file. See the import-order rule above.

**`Unable to resolve module @signalwire/react-native/polyfills`** — Metro package
exports are off. Set `resolver.unstable_enablePackageExports = true`.

**`Static class blocks are not enabled`** — add
`@babel/plugin-transform-class-static-block` to `babel.config.js`.

**`MissingPeerDependencyError`** — the named package is absent, or installed but
not natively linked. Install it and rebuild the native app (`npx expo prebuild
--clean`, or a fresh pod install / gradle build).

**Call connects on iOS but is silent** — audio started before CallKit activated
the audio session. The bridge gates on `didActivateAudioSession`; if you start
media yourself, wait for that event too.

**Network loss is not detected** — `@react-native-community/netinfo` is not
installed. The platform logs a warning and continues with reduced resilience.

## Development

```bash
npm install
npm test                # 192 unit tests, ~95% statement coverage
npm run type-check
npm run lint
npm run build
npm run bundle-check     # Metro bundles the example for iOS and Android
npm run verify           # all of the above, in order
npm run verify:package   # publint + are-the-types-wrong on the built package
npm run verify:prebuild  # real `expo prebuild`, asserts the config plugin applied
```

Native behaviour cannot be verified without a device. To pick this up on a
fresh machine, start with [`TESTING.md`](TESTING.md) — it covers environment
bootstrap, the expected output of every check, a known Android build blocker,
and failure triage. [`docs/device-testing.md`](docs/device-testing.md) is the
12-scenario hardware checklist it ends at.
