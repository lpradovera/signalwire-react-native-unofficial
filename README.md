# `@signalwire/react-native`

> **Alpha.** On its way to becoming SignalWire's supported React Native SDK;
> APIs may change between alpha releases.

React Native support for [`@signalwire/js`](https://www.npmjs.com/package/@signalwire/js) v4.
Supplies the platform adapters the browser-oriented SDK needs on mobile, an
idiomatic React API over its RxJS observables, and native call UI through
CallKit and ConnectionService.

Supports iOS 15.1+ (React Native's own minimum from 0.76 on) and Android 8+,
on React Native 0.76+ (bare or Expo), with
**React Native's New Architecture only** (the default since 0.76; React
Native 0.82 removes the old one). Apps that set `newArchEnabled: false` are
not supported. The native peers (react-native-webrtc, callkeep,
react-native-incall-manager) run through React Native's interop layer for
legacy modules and views.

## What is verified

Two levels, kept apart on purpose. **Signed off** means a row of the sign-off
table in [`docs/device-testing.md`](docs/device-testing.md), the record
[`TESTING.md`](TESTING.md) asks testers to keep. **Observed** means it was seen
working on a device or emulator during development (commit messages and
`device-testing.md`'s narrative sections) but has no sign-off row yet.

| | iOS | Android |
| --- | --- | --- |
| Outbound calls, with audio | ✅ signed off (iPad, iPadOS 17) | observed (emulator, Android 16) |
| Inbound push → native call UI | ✅ signed off (PushKit + CallKit) | observed (FCM + ConnectionService) |
| Answer from a **running** app | ✅ signed off | observed |
| Answer from a **killed** app | observed | observed (release build — see note) |
| Two-way audio on a bridged call | observed | observed |
| Hang-up propagation, both directions | observed | observed |

**No Android row is signed off.** The Android column of the sign-off table is
empty; what it shows here comes from development runs on an emulator (for
example the cold-start answer recorded in commit `7fbce1b`). On iOS the table
signs off outbound audio, inbound with CallKit, the cold-start push reaching
CallKit, and an unmatched push ending itself; the other iOS rows are observed
only.

These rows were verified on the old architecture. On the New Architecture the
example app has been built and launched on the iOS 27 Simulator with every
native peer; the device rows are still to be repeated on it.

Android cold start needs a **release** build to be tested meaningfully: the
Expo dev client starts a second JS runtime for the activity, so the entry
created by the headless push task is not in the context that draws the UI. With
debug logging on (`EXPO_PUBLIC_SW_WIRE_LOG=1` in the example, or
`setLogLevel('debug')` from `@signalwire/js`), one `Android call push
registered` line means one runtime and two mean you are testing the dev
client, not your app. At the SDK's default `warn` level the line never prints,
so zero lines means the logging is off, not that the handler is missing.

**Known gaps**

- **Android's incoming-call UI is a notification.** With the package's Android
  module linked (rebuild the app after upgrading), a call to a backgrounded or
  killed app rings as a call notification with Answer and Decline, and opens
  the app over the lock screen through its full-screen intent; the app's own
  ringing UI takes it from there. On Android 14+ the user can revoke
  full-screen intents in Settings, and then the notification only rings.
- **A call's type is fixed when it is answered.** An outbound call's audio
  mode and CallKit type come from its own media (`call.mediaDirections`). An
  inbound call is answered audio-only, so it is a voice call. A pushed call
  starts its audio when its call connects, with that call's media. A later
  change of media during the call (adding or dropping video) re-modes
  neither the audio session nor CallKit.

## Packages

| Install this | If you are building | Contains |
| --- | --- | --- |
| [`@signalwire/react`](packages/react) | A **browser** app | Provider and hooks. No platform code. |
| [`@signalwire/react-native`](packages/react-native) | A **React Native** app | The above, re-exported, plus adapters, video view, CallKit and audio routing. |
| [`@signalwire/react-ui`](packages/react-ui) | A **browser** app wanting ready-made UI | React wrappers for the SDK's Lit components. Optional. |
| [`@signalwire/react-native-ui`](packages/react-native-ui) | An **RN** app wanting ready-made UI | Native call controls, dialpad, participants, device picker, incoming-call sheet. Optional. |

The hooks are identical on both. React Native apps install one package and get
everything; browser apps install the core and skip the native weight entirely.

```mermaid
graph TD
    js["<b>@signalwire/js</b><br/>signalling · WebRTC · calls"]
    core["<b>@signalwire/react</b><br/>provider + hooks<br/><i>no platform code</i>"]
    wc["<b>@signalwire/web-components</b><br/>Lit elements"]

    subgraph browser [" Browser "]
        rui["<b>@signalwire/react-ui</b><br/>React wrappers for<br/>the Lit components"]
    end

    subgraph native [" React Native "]
        rn["<b>@signalwire/react-native</b><br/>CallKit · push tokens · polyfills<br/>audio routing · video view · Expo plugin"]
        rnui["<b>@signalwire/react-native-ui</b><br/>call controls · dialpad<br/>incoming-call sheet"]
    end

    js --> core
    js --> rui
    wc --> rui
    core --> rn
    core --> rnui
    rn --> rnui

    classDef published fill:#1f6feb18,stroke:#1f6feb,stroke-width:2px
    classDef peer fill:#8b949e18,stroke:#8b949e,stroke-dasharray:4 3
    class core,rui,rn,rnui published
    class js,wc peer
    style browser fill:none,stroke:#8b949e,stroke-dasharray:3 4
    style native fill:none,stroke:#8b949e,stroke-dasharray:3 4
```

Arrows point from a package to what is built on top of it. Solid boxes are
published from this repository; dashed ones are peer dependencies you install
alongside.

Two things the diagram is meant to make obvious. `@signalwire/react` holds
every hook and knows nothing about a platform — that is what lets the same
`useCall` drive a browser tab and an iPad. And `@signalwire/react-ui` does
**not** sit on `@signalwire/react`: it wraps the SDK's Lit components directly,
so the two UI packages are siblings by name only and share no code.

### Entry points

| Import | For |
| --- | --- |
| `@signalwire/react-native` | Provider, hooks, video view, `displayableName` |
| `@signalwire/react-native/polyfills` | **Must be line 1** of your entry file |
| `@signalwire/react-native/callkit` | Native call UI, push tokens, `registerAndroidCallPush` |
| `@signalwire/react-native/audio` | Speaker / earpiece / headset / Bluetooth routing |
| `@signalwire/react-native/ringing` | `useRingingPushes` and `displayableName`, for drawing your own incoming-call UI |

`./ringing` is deliberately separate from `./callkit`: the latter loads
callkeep, which constructs a `NativeEventEmitter` at import time, and
`./ringing` loads none of it. The main entry loads callkeep too (see
[Install](#install)) when the app has it.

## Repository layout

| Path | What it is |
| --- | --- |
| [`packages/react/`](packages/react) | Universal core — provider and hooks |
| [`packages/react-ui/`](packages/react-ui) | React wrappers for the SDK's web components |
| [`packages/react-native/`](packages/react-native) | React Native platform layer |
| [`packages/react-native-ui/`](packages/react-native-ui) | React Native call UI components |
| [`example/`](example) | Expo dev-client demo app |
| [`examples/web/`](examples/web) | Vite browser demo — proves the core is universal |
| [`server/`](server) | Support server — device-token registry and APNs VoIP / FCM sender |
| [`docs/`](docs) | Native setup, push setup, device-test checklist |
| [`TESTING.md`](TESTING.md) | How to verify all of it, from a cold start |

## How a call flows

An **outbound** call is short, and involves no server at all once the app has a
token: `dial()` goes to SignalWire over the already-open WebSocket, and media
flows. Everything below is the **inbound** path, which is where the parts
divide up — and where every hard bug in this repository has been.

```mermaid
sequenceDiagram
    autonumber
    participant C as Caller<br/>examples/web or PSTN
    participant SW as SignalWire
    participant S as Support server<br/>server/
    participant P as APNs / FCM
    participant N as Device, native side<br/>react-native/callkit
    participant J as App JavaScript<br/>example/ + hooks

    rect rgba(139,148,158,0.10)
    Note over J,S: At launch, long before any call
    J->>S: POST /token → subscriber token
    J->>SW: open + authenticate the WebSocket
    J->>S: POST /devices → PushKit / FCM token
    end

    C->>SW: dial /public/rn-example-park
    SW->>S: POST /swml/park
    S->>S: mint a single-use bridge token
    S->>P: notify — correlationId is the token, never the call SID
    S-->>SW: SWML: answer, then loop ringback
    Note over C,SW: The caller is parked and hears ringback.<br/>This removes the race: a device woken by push<br/>needs seconds to launch and authenticate.
    P->>N: VoIP push (iOS) / data message (Android)
    N->>N: reportIncomingPush → native call UI rings
    Note over N: iOS: PushKit wakes the app natively, before JS exists.<br/>Android: a headless task runs registerAndroidCallPush.
    N->>J: answerRequested$ — the user tapped Answer
    J->>J: wait for the SDK connection<br/>(a cold start may still be connecting)
    J->>SW: dial(bridge address ?bridgeToken=…)
    SW->>S: POST /swml/bridge
    S->>S: redeem the token → the parked call SID
    S-->>SW: SWML: connect to the parked leg
    SW-->>C: legs joined — audio flows
```

Who owns what:

| Role | Lives in | Notes |
| --- | --- | --- |
| Placing and receiving calls, media | `@signalwire/js` via `@signalwire/react` | Platform-agnostic; the hooks are the whole API |
| Native call UI, push tokens, ringing | `@signalwire/react-native/callkit` | CallKit on iOS, ConnectionService on Android |
| Waking a killed app | The OS, via PushKit / FCM | On iOS this happens **before any JavaScript exists** |
| Deciding who to ring, sending the push | `server/` — a scaffold, reimplement it | SignalWire has no push infrastructure; this is the missing middle |
| Parking the caller and bridging | `server/` SWML routes | `/swml/park` and `/swml/bridge` |
| Answering into a bridge dial | The **app**, not the package — `example/src/useBridgeAnswer.ts` | Deliberately app-level: the bridge address and token policy are yours |

Three consequences worth reading off the diagram:

- **The device dials out to answer.** It never receives an invite. The caller
  is parked and the woken device joins them, which is why an inbound call needs
  a publicly reachable server and an outbound one does not.
- **The push carries a token, not the call SID.** A payload containing the SID
  would be a capability anyone replaying it could spend. The server resolves
  the single-use token instead — which is also why answering twice fails
  cleanly.
- **Three processes must agree, and each fails silently.** The push can land
  while the app has no bundler, the funnel can be down so SignalWire never
  reaches `/swml/park`, or the SDK can still be connecting when the user hits
  Answer. All three look identical on the device: the call never arrives. See
  [`docs/device-testing.md`](docs/device-testing.md) for bringing the whole
  chain up and proving each link.

## Install

The packages are published as an alpha, under npm's `alpha` tag. Ask for it
by tag (or by exact version): a plain `npm install @signalwire/react-native`
still gets the `latest` tag, SignalWire's older 1.x SDK (signalwire-node),
until 2.0.0 is released.

```bash
npm install @signalwire/react-native@alpha @signalwire/js rxjs \
  react-native-webrtc \
  @react-native-async-storage/async-storage \
  react-native-get-random-values \
  react-native-url-polyfill \
  @signalwire/react-native-callkeep \
  react-native-incall-manager \
  @react-native-community/netinfo
# for the call-screen components: also @signalwire/react-native-ui@alpha
```

All of these are needed, the last three included: the main entry imports
them. `SignalWireProvider` loads the native call bridge, which loads callkeep
and, for audio routing, imports `react-native-incall-manager`;
`createReactNativePlatform()` imports `@react-native-community/netinfo` for
network-loss detection. Without incall-manager or netinfo installed, Metro
cannot bundle the app (`Unable to resolve module react-native-incall-manager`).
Without callkeep the app bundles, but the native call UI's `setup()` throws
`MissingPeerDependencyError`. They are native modules, so rebuild the app
after installing them.

**callkeep: install `@signalwire/react-native-callkeep`,** the
SignalWire-maintained fork of react-native-callkeep (same JS API, pod
`RNCallKeep`, Android package `io.wazo.callkeep`). Stock
`react-native-callkeep` still works, and the package uses it when the fork is
not installed, but it lacks the fork's fixes: on Android, stock 4.3.16 crashes
at launch on the New Architecture (two `@ReactMethod`s with one name), its
`onHostDestroy` kills the process before a call's `endCall` reaches
JavaScript, and it has no `didFailCallAction` or Telecom route details. The
fork's [CHANGELOG](https://github.com/signalwire/react-native-callkeep/blob/signalwire/main/CHANGELOG.md)
lists everything it adds. Until `@signalwire/react-native-callkeep` is on npm,
install it from GitHub:
`npm install github:signalwire/react-native-callkeep#v4.4.0`.

`@signalwire/react` comes with `@signalwire/react-native` as a dependency.
The four `@signalwire/*` packages of this repository are released together at
one version, and where one needs another it names it at that version:
`@signalwire/react-native` depends on `@signalwire/react`, and
`@signalwire/react-native-ui` takes both as peers. `@signalwire/react` and
`@signalwire/react-ui` depend on no other package of the four.

**From the repository instead** (an unreleased commit, or a fork): build the
packages and install the tarballs.

```bash
git clone https://github.com/lpradovera/signalwire-react-native-unofficial.git
cd signalwire-react-native-unofficial
npm install
npm run build
TARBALLS="$PWD/../signalwire-tarballs"   # anywhere; an absolute path
mkdir -p "$TARBALLS"
npm pack -w @signalwire/react -w @signalwire/react-native --pack-destination "$TARBALLS"
# For the call-screen components, add -w @signalwire/react-native-ui above,
# and its tarball to the install below.
```

Then, in your app (any directory; `TARBALLS` as above), install every
tarball that was packed, plus the peers above. The names carry the version,
so use a glob rather than writing it out:

```bash
npm install "$TARBALLS"/signalwire-react-[0-9]*.tgz \
  "$TARBALLS"/signalwire-react-native-[0-9]*.tgz
# with react-native-ui: also "$TARBALLS"/signalwire-react-native-ui-[0-9]*.tgz
```

Pack from one checkout at a time: a tarball left from an older version
matches the glob too. npm records a `file:` dependency for each tarball.
Copying the tarballs (or the unpacked packages) into the app, under
`vendor/` say, keeps the install reproducible on another machine and in CI.

What each native peer is for:

| Package | What uses it |
| --- | --- |
| `@signalwire/react-native-callkeep` (or stock `react-native-callkeep`) | Native call UI (CallKit, ConnectionService); `@signalwire/react-native/callkit` |
| `react-native-incall-manager` | Speaker/earpiece/headset/Bluetooth routing; `@signalwire/react-native/audio` (iOS beyond speaker on/off: see [Audio routes on iOS](#audio-routes-on-ios)) |
| `@react-native-community/netinfo` | Network-loss detection and SDK reconnection |

`MissingPeerDependencyError`, which names the package and the fix, is for a
peer that is installed but not linked, such as a dev client not rebuilt since
the package was added. A peer that is not installed fails the bundle, as
above, except callkeep: the package loads whichever of its two names the app
has, and throws `MissingPeerDependencyError` from `setup()` when it has
neither.

**This package has a little native code on iOS** (`ios/`, pod
`SignalWireReactNative`): the system audio output button,
`AudioRoutePickerButton`. It autolinks, but only into a rebuilt app: run
`pod install` (Expo: `expo prebuild` or `expo run:ios`) after installing or
upgrading. Until then the button renders nothing, and it also renders
nothing without incall-manager's iOS routes (see
[Audio routes on iOS](#audio-routes-on-ios)). Everything else, audio
routing included, is JavaScript over the peers above.

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

Four things break without it:

- The SDK bundles `uuid`, which reads `crypto.getRandomValues`. Hermes has none.
- The SDK parses dial destinations with `new URL('destination:' + address)`.
  React Native's built-in `URL` silently drops a non-HTTP scheme, so every
  `dial()` targets the wrong address.
- The SDK's entry point dispatches a `CustomEvent` on `window` at import time,
  guarded only by `typeof window !== 'undefined'`. React Native satisfies that
  guard but provides neither `CustomEvent` nor `window.dispatchEvent`, so
  importing `@signalwire/js` throws.
- The SDK calls ES2025 iterator helpers (`Iterator.prototype.map`/`.find`) on
  Map iterators. Hermes does not implement them, so touching the directory
  throws `values().map is not a function`. This one is lazy rather than
  import-time, which makes it easy to miss in a quick smoke test.

Without the import (or with it after another import that loads the SDK), the
app fails before this package's own checks can run: importing
`@signalwire/react-native` loads `@signalwire/js`, and Hermes stops with
`ReferenceError: Property 'CustomEvent' doesn't exist`. `createReactNativePlatform()`
also checks the random-values and URL polyfills and throws
`PolyfillNotInstalledError` naming the fix, but that check is reached only
when something else in the app already supplies `CustomEvent` and
`window.dispatchEvent`. Nothing checks the iterator helpers; their absence
shows only as `values().map is not a function`.

## Two build-config requirements — Expo SDK 52 only

**On Expo SDK 53 and newer, neither of these is needed.** The example app runs
on SDK 54 with a stock `babel.config.js` and no package-exports flag. They are
kept documented because the package still supports `react-native >=0.76.0`,
which includes SDK 52.

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
them in its ESM build, and `babel-preset-expo` did not handle them before
SDK 53:

```bash
npm install -D @babel/plugin-transform-class-static-block
```

```js
// babel.config.js
plugins: ['@babel/plugin-transform-class-static-block'];
```

## Quick start

New to this? [**docs/tutorial.md**](docs/tutorial.md) walks from
`create-expo-app` to a ringing phone, with a checkpoint at each stage. The
snippet below is the 30-second version.


```tsx
import {
  SignalWireProvider,
  SignalWireVideoView,
  useCall,
  useSignalWire
} from '@signalwire/react-native';
import { useEffect, useMemo, useState } from 'react';
import { Button, Text, View } from 'react-native';

import type { Call, CredentialProvider } from '@signalwire/js';

const ENDED = new Set(['disconnected', 'destroyed', 'failed']);

function ActiveCall({ call, onEnded }: { call: Call; onEnded: () => void }) {
  const { status, hangup } = useCall(call);

  // Back to the dialer when the call ends, whichever side hangs up.
  useEffect(() => {
    if (ENDED.has(status)) onEnded();
  }, [status, onEnded]);

  return (
    <View style={{ flex: 1 }}>
      <SignalWireVideoView call={call} kind="remote" style={{ flex: 1 }} />
      <Button title={`End (${status})`} onPress={() => void hangup().catch(onEnded)} />
    </View>
  );
}

function Dialer() {
  const { isConnected, dial } = useSignalWire();
  const [call, setCall] = useState<Call | null>(null);
  const [dialing, setDialing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  if (call) return <ActiveCall call={call} onEnded={() => setCall(null)} />;

  const start = () => {
    setDialing(true);
    setFailure(null);
    dial('/public/my-room', { audio: true, video: true })
      .then(setCall, (e: unknown) => setFailure(String(e)))
      .finally(() => setDialing(false));
  };

  return (
    <View>
      <Button title="Call" disabled={!isConnected || dialing} onPress={start} />
      {failure && <Text>{failure}</Text>}
    </View>
  );
}

export default function App() {
  // Memoize: a new identity tears down the client and rebuilds it, which
  // hangs up any call in progress. To rotate a token mid-call, return
  // `expiry_at` from authenticate() and implement refresh() instead.
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

A pasted token expires. For a real app, pass `fetchToken` instead: the
provider fetches from your server to connect, renews ahead of expiry, on
foreground and on a call push, retries failures, and reports a 401 or 403
through `useSignalWire().tokenStatus`. See [docs/tokens.md](docs/tokens.md).

```tsx
const fetchToken = async () => {
  const body = await (await fetch(TOKEN_URL, { method: 'POST' })).json();
  return { token: body.token, expiresAt: body.expires_at };
};

<SignalWireProvider fetchToken={fetchToken}>
```

## Hooks

| Hook | Returns | Entry point |
| --- | --- | --- |
| `useSignalWire()` | `client`, `isConnected`, `isRegistered`, `user`, `directory`, `error`, `tokenStatus`, `dial`, `connect`, `disconnect` | `@signalwire/react-native` |
| `useCall(call)` | `status`, `participants`, `self`, `localStream`, `remoteStream`, `isAudioMuted`, `isVideoMuted`, `error`, `hangup`, `toggleHold`, `setAudioMuted`, `setVideoMuted`, `sendDigits` | `@signalwire/react-native` |
| `useIncomingCalls()` | `calls`, `answer` (holds a call in progress first), `endAndAnswer` (ends it first), `reject` | `@signalwire/react-native` |
| `useCalls()` | `calls` in progress, `activeCall`, `heldCalls`, `isHeld`, `hold`, `unhold`, `swap` (call waiting) | `@signalwire/react-native` |
| `useDevices()` | `audioInputs`, `videoInputs`, selection, `refresh` | `@signalwire/react-native` |
| `useObservable(obs$, initial)` | The latest value of any SDK observable | `@signalwire/react-native` |
| `useAudioRoute()` | `route`, `setRoute`, `setSpeakerOn` | `@signalwire/react-native/audio` |
| `useAudioDevices()` | `available`, `selected`, `selectedName` (e.g. the car's name). iOS, with incall-manager iOS routes. Live while a call's session runs; outside a call, the last status read. | `@signalwire/react-native/audio` |
| `getAudioDeviceStatus()` (function) | The same status, read now, for code outside React. Resolves `null` without iOS routes (the hook gives an empty status instead). | `@signalwire/react-native/audio` |

`useObservable` is built on `useSyncExternalStore`, so it is tear-free under
concurrent rendering, and it seeds from the SDK's synchronous getters rather
than flashing a default. Every hook is safe with a null call or client.

### Audio routes

`useAudioRoute()` has four routes, one for each of incall-manager's devices:
`'earpiece'` (the receiver), `'speaker'`, `'headset'` (a wired or USB-C
headset) and `'bluetooth'` (a Bluetooth headset or a car). Use `setSpeakerOn(on)` for a speaker toggle: off returns to the
route the call had before (a connected headset or car, or the receiver).
`setRoute(route)` is a choice of that route; `setRoute('earpiece')` means the
phone's receiver, as on Android, and with iOS routes it moves a call off a
connected headset or car. A toggle written as
`setRoute(route === 'speaker' ? 'earpiece' : 'speaker')` should use
`setSpeakerOn(route !== 'speaker')`.

A route chosen before the call's audio session starts (a speaker tap while an
outbound CallKit call still rings) shows at once and is applied when the
session starts; if the call ends first, it is dropped. The CallKit bridge
starts and stops the session for the calls it tracks. Without CallKit (or
for a call it doesn't track), call `getAudioRouteController().start(media)`
when the call connects and `stop()` when it ends; with no session only the
speaker setting can be written, and only on iOS (speaker on and off;
`'headset'` and `'bluetooth'` are ignored with a warning), because on
Android incall-manager refuses every route before its `start()`. A video call starts on the speaker only when nothing else is
connected: incall-manager's own start decides, and this package doesn't force
the speaker over a headset or car. `route` shows the media's default (`'speaker'`
for video) until the session's first status replaces it: on Android
incall-manager reports its devices, and with iOS routes the session reads
them; a choice made before that status is held and then applied to the
reported route. A route that can't be chosen (no such device) goes back to
where it was, on Android too.

#### Audio routes on Android

A call the CallKit bridge tracks runs in callkeep's self-managed
ConnectionService, and Telecom routes its audio. The package then asks
Telecom for every route (`Connection.setAudioRoute`, through callkeep's
`setAudioRoute`) and `route` follows Telecom's reports (callkeep's
`didChangeAudioRoute`): a choice in the system's output switcher, a
Bluetooth headset or car connecting or dropping, a wired headset plugged in.
Speaker off returns to the route the call had before: the receiver, the
wired headset, or the Bluetooth device. A route Telecom doesn't offer the
call, or doesn't move it to, goes back to where Telecom has it. A video call
Telecom starts on the receiver is moved to the speaker; one on a headset or
car stays there.

incall-manager's session isn't started for such a call: its `start()` routes
the call through AudioManager behind Telecom (the two then disagree, Telecom
on the receiver while incall-manager forces the speaker). Telecom sets the
audio mode and takes audio focus for the call. The package still uses
incall-manager to keep the screen on during the call and to blank it while
the phone is at the ear on the receiver (its proximity sensor).

The routes Telecom offers come with each of callkeep's reports when
callkeep is the SignalWire fork (`@signalwire/react-native-callkeep`, which adds them and the
Bluetooth device to `didChangeAudioRoute`); the state before the first
report, and every report from stock callkeep (which reports only the route),
is read from the call's `CallAudioState` by the package's Android library, so
rebuild the app after upgrading. Before the rebuild, the route still follows
Telecom and every route can be asked for. Choosing between two Bluetooth
devices isn't offered yet: the package asks Telecom for "Bluetooth", which
uses the active device (the fork's `setAudioRouteBluetoothDevice` can pick
one).

A call the bridge doesn't track (an app that calls
`getAudioRouteController().start(media)` itself), or one Telecom refused, is
routed by incall-manager as before.

#### Audio routes on iOS

This package never writes the iOS audio session itself: incall-manager does,
and so do callkeep (its category and mode on every CallKit activation) and
WebRTC. Released incall-manager (through 4.3.0) has iOS speaker on/off only,
and what you get depends on which you have:

| | incall-manager 4.3.0 | incall-manager with iOS routes |
| --- | --- | --- |
| Speaker on / off | ✅ | ✅ |
| `setRoute('earpiece')` | Speaker off; a connected headset or car keeps the call | The receiver |
| `setRoute('headset')` | Speaker off; a plugged-in headset takes the call | The wired or USB-C headset |
| `setRoute('bluetooth')` | Ignored, with one warning | A connected Bluetooth headset or car |
| `route` | What was asked for; at start the media's default (`'speaker'` for video), even when iOS kept the call on a headset or car | What iOS reports: the starting device, a headset or car connecting or dropping, a choice in the system route menu or CallKit |
| `useAudioDevices()` | Empty | The devices, by name, kept current during a call |

iOS routes come from a change to incall-manager that is proposed upstream
(chooseAudioRoute, getAudioDeviceStatus and onAudioDeviceChanged on iOS, with
incall-manager following route changes it didn't make). To use it now, apply
[`docs/patches/react-native-incall-manager+4.3.0.patch`](docs/patches/react-native-incall-manager+4.3.0.patch)
with [patch-package](https://github.com/ds300/patch-package): pin
`react-native-incall-manager` to `4.3.0`, install patch-package
(`npm install --save-dev patch-package`), copy the file into your app's
`patches/`, add `"postinstall": "patch-package"` to its scripts, run
`npm install` (which applies it), and rebuild the app (native code). A vendored copy of incall-manager with the same change works the same
way. This package detects the iOS routes at run time, so nothing else
changes; without them it falls back as in the first column.

For iOS's own output menu, render `<AudioRoutePickerButton />` from
`@signalwire/react-native/audio` (an `AVRoutePickerView`, which lists the phone,
the speaker and each connected headset or car by name, and switches the call
itself). `CallControls` in `@signalwire/react-native-ui` shows it on iOS next
to the speaker toggle; `showRoutePicker` defaults to `showAudioRoute`. The
button needs incall-manager's iOS routes, which follow a choice made there
(`route` reports it) and keep it. **On released incall-manager 4.3.0 the
button isn't rendered** (`isAudioRoutePickerAvailable()` is false): nothing
would report its choice, and 4.3.0 re-applies the speaker on the next audio
category change, undoing it. There `CallControls` offers speaker on/off
only; for full routing, apply the incall-manager patch above
(`docs/patches/`) or wait for the upstream change. VoiceOver reads the button as
a button, "Audio output" (`accessibilityRole`, `accessibilityLabel`). Its
`style` (background, border, radius, padding) is drawn once, on the view around
the native picker, the padding insets the icon, and a tap anywhere in that view
opens the menu. Its `activeTintColor` is AVKit's
colour for AirPlay being active; a headset or car is not AirPlay.

`useDevices()` has no `refresh`-free auto-update: React Native emits no
`devicechange` event, so the platform sets `skipDeviceMonitoring: true` and you
call `refresh()` yourself — typically on app foreground or when opening a picker.

## Native call UI

```ts
// index.js — before React mounts, so a cold-start VoIP push finds it ready
import { getCallKit } from '@signalwire/react-native/callkit';

void getCallKit().setup({ appName: 'My App', supportsVideo: true });
```

`supportsVideo` lets the native UI offer video; it does not make a call a
video call. An outbound call is a video call when its own media
(`call.mediaDirections`) sends or receives video, and starts on the speaker;
every other call, including every inbound call (always answered audio-only),
is a voice call on the earpiece.

```tsx
<SignalWireProvider credentialProvider={credentials} callKit>
```

The native call UI and Recents show an outbound call by a readable form of its
destination: a Fabric address's last segment, humanised (`/private/support-agent`
shows as `Support Agent`), a SIP URI's user part, or a number as it is. To show
a name of your own, pass options in place of `true`:

```tsx
<SignalWireProvider credentialProvider={credentials} callKit={{ displayName: (to) => contacts[to] ?? to }}>
```

The observer is built when `callKit` turns on and dropped when it turns off,
which also stops CallKit from showing the client's inbound calls; changing
only the options doesn't rebuild it. Each call reads the latest
`displayName`, so it can close over data that loads later. A Fabric address
it returns is made readable the same way. If it throws or returns an empty
string, the call is named by its destination: the call has already been placed
by then, so it is still tracked. An inbound call's `fromName` that is a Fabric
address is shown readably too, and the placeholder `_undef_` some calls carry
for a missing name shows as "Unknown caller" (with a debug log line).

**Without the native call UI** (`callKit` off), on Android:

- The provider runs the package's `microphone` foreground service while a
  call is in progress, so Android 14+ doesn't silence the microphone when the
  screen locks or the app goes to the background. The library manifest
  declares it; see [native setup](docs/native-setup.md#android-calls-without-the-native-call-ui).
- Ask for `BLUETOOTH_CONNECT` (Android 12+) at runtime yourself: `setup()`
  does it for `callKit` apps, and without the grant no Bluetooth headset or
  car is ever a route. See
  [runtime permissions](docs/native-setup.md#android-runtime-permissions).

### Call waiting

A second call can ring during a live one, on iOS and Android alike. The
`callWaiting` setup option picks how much of that the app allows, and every
mode behaves the same on both platforms:

| `callWaiting` | A call comes in during a call | Dialling during a call |
| --- | --- | --- |
| `'full'` (default) | It rings: **Hold & Accept** (the live call goes on hold), **End & Accept**, or **Decline**. The two calls can then be swapped, and either ended. | Places the call and puts the live one on hold. |
| `'endAndAccept'` | It rings: **End & Accept** or **Decline**. | `CallInProgressError` |
| `'single'` | Refused as busy (SIP 486), never shown. | `CallInProgressError` |

```ts
void getCallKit().setup({ appName: 'My App', callWaiting: 'endAndAccept' });
```

In `'full'` mode there are at most two calls, one active and one waiting or
on hold: a third incoming call is refused as busy, and a third dial throws
`CallInProgressError`. Calls are never merged.

Where the choice is offered:

- **iOS**: CallKit's own waiting-call screen offers Hold & Accept (with
  `'full'`, which reports two call groups), End & Accept and Decline, over
  the lock screen too, and its in-call screen holds and swaps.
- **Android**: Telecom draws nothing for a self-managed call, so the app does.
  `IncomingCallSheet` (`@signalwire/react-native-ui`) shows over a call in
  progress with the buttons the mode allows; in the background the
  incoming-call notification's Answer is Hold & Accept (End & Accept outside
  `'full'`).
- **Your own UI**: `useIncomingCalls().answer(call)` is Hold & Accept,
  `endAndAnswer(call)` is End & Accept. `useCalls()` gives the calls in
  progress, the `activeCall`, the `heldCalls`, and `hold`, `unhold` and
  `swap`. Every hold, from the app, CallKit or Telecom, goes through one
  hold state per call, so the native UI and the app always agree.

The audio session follows the active call: it is never stopped while a held
call is left, and on Android the active call's Telecom connection routes the
audio. A held call sends no media and receives none, **with the
@signalwire/js hold patch** below.

**Apply the SDK hold patch.** @signalwire/js 4.0.0-rc.5 holds a call on the
server only: without the patch a held call keeps sending your microphone, and
the SDK's network recovery restarts ICE on the held call because it receives
nothing. Copy [`patches/@signalwire+js+4.0.0-rc.5.patch`](patches/@signalwire+js+4.0.0-rc.5.patch)
into your app's `patches/` directory and apply it with
[patch-package](https://github.com/ds300/patch-package)
(`"postinstall": "patch-package"`). The library logs a warning once if a call
is held without it. See [docs/patches](docs/patches/README.md).

```tsx
const { activeCall, heldCalls, swap } = useCalls();
// …
{heldCalls.map((call) => (
  <HeldCallRow key={call.id} call={call} onSwap={swap} onEnd={() => call.hangup()} />
))}
```

Outside `'full'`, `dial()` rejects with `CallInProgressError` before anything
is placed while a call is live (a ringing push included). Answering a push by
dialling a bridge is never refused.

```ts
import { CallInProgressError } from '@signalwire/react-native';

try {
  setCall(await dial(destination));
} catch (error) {
  if (error instanceof CallInProgressError) {
    showToast('Hang up the current call first');
  } else {
    throw error;
  }
}
```

### Back keeps the call running (Android)

Back on the root screen destroys the activity, which unmounts the app. By
default the call goes on: callkeep keeps its connection
(`endCallsOnHostDestroy: false`), `SignalWireProvider` keeps the client and
its calls instead of hanging up, and the ongoing-call notification brings the
app back, where the provider takes the same client back and `useCalls()`
finds the call. Once the kept calls end with the app still closed, the client
is torn down. The provider does the same on iOS if your root unmounts.

To have Back end the call instead (the old behaviour):

```ts
void getCallKit().setup({ appName: 'My App', endCallsOnHostDestroy: true });
```

If the process dies mid-call (killed by the system or by the user), nothing
on the device can send a bye; see
[device testing](docs/device-testing.md) for what the server does then.

Calls appear in the Phone app's Recents. To call back from there, or from
Siri, dial what `getCallKit().startCallRequested$` emits (`handle`,
`displayName`, `video`); the Expo plugin generates the native forwarder it
needs. See [native setup](docs/native-setup.md#ios-calling-back-from-recents-and-siri).

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

**The bridge consumes callkeep's launch buffer.** callkeep holds the events
that fired before JavaScript started and sends them to `didLoadWithEvents`
listeners; the bridge replays the call events among them and then calls
`RNCallKeep.clearInitialEvents()`, because callkeep would otherwise send the
same buffer again after an in-process JS reload. After that,
`RNCallKeep.getInitialEvents()` resolves `[]`. To see the launch events
yourself (a buffered mute, say), register your own `didLoadWithEvents`
listener in your entry file: it receives the same dispatch. A Recents or Siri
call-back that launched the app is among them (the plugin's
`continueUserActivity` forwarder hands it to callkeep), and the bridge also
delivers it through `startCallRequested$`.

A runnable support server lives in [`server/`](server/) — device-token registry,
APNs VoIP and FCM senders, and a webhook endpoint.
**[`docs/push-setup.md`](docs/push-setup.md) is the full end-to-end guide** —
Apple/Firebase setup, the generated PushKit hook, backend senders for APNs VoIP and
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

**`ReferenceError: Property 'CustomEvent' doesn't exist`** at startup, or
**`PolyfillNotInstalledError`** — `@signalwire/react-native/polyfills` is missing
or not first in your entry file. See the import-order rule above.

**`Unable to resolve module @signalwire/react-native/polyfills`** — Metro package
exports are off. Set `resolver.unstable_enablePackageExports = true`. Expo SDK 52
only; on by default from SDK 53.

**`Static class blocks are not enabled`** — add
`@babel/plugin-transform-class-static-block` to `babel.config.js`.

**`MissingPeerDependencyError`** — the named package is absent, or installed but
not natively linked. Install it and rebuild the native app (`npx expo prebuild
--clean`, or a fresh pod install / gradle build).

**Call connects on iOS but is silent** — audio started before CallKit activated
the audio session. The bridge gates on `didActivateAudioSession`; if you start
media yourself, wait for that event too.

**Network loss is not detected** — check for `Network monitoring unavailable,
continuing with reduced resilience` in the log: the NetInfo shim could not
start, and the line carries the reason. Also check the app did not pass
`platform={{ netInfo: false }}` to the provider (or `netInfo: false` to
`createReactNativePlatform()`). (`@react-native-community/netinfo`
itself must be installed, or the app does not bundle; see [Install](#install).)

## Development

```bash
npm install
npm test                # every package's unit tests, then the server's
npm run type-check
npm run lint
npm run build
npm run bundle-check     # Metro bundles the example for iOS and Android
npm run verify           # all of the above, in order
npm run verify:package   # publint + are-the-types-wrong on all four packages
npm run verify:prebuild  # real `expo prebuild`, asserts the config plugin applied
```

Native behaviour cannot be verified without a device. To pick this up on a
fresh machine, start with [`TESTING.md`](TESTING.md) — it covers environment
bootstrap, the expected output of every check, a known Android build blocker,
and failure triage. [`docs/device-testing.md`](docs/device-testing.md) is the
12-scenario hardware checklist it ends at.
