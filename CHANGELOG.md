# Changelog

## Unreleased

### CallKit voice and video

- A call's CallKit type and audio session mode follow its own media
  (`call.mediaDirections`, the SDK's answer once preferences, `?channel=`,
  the dial options and a disabled camera are applied), for outbound and
  inbound calls. A voice call starts on the receiver, or on a connected
  headset or car, instead of the loudspeaker. This corrects the 0.1.0 known
  gap "A voice call forces speakerphone".
- A call is reported to CallKit as video only when the provider was set up
  with `supportsVideo: true`.
- `CallKeepBridge.trackCall(call, handle, displayName)` keeps its signature;
  it reads the media from the call, falling back to `supportsVideo` for a call
  without `mediaDirections`.
- New `AudioRouteController.updateMedia(media)`. A push answered before its
  SDK call exists starts in the app's mode; when its call arrives voice only,
  audio moves off the speaker unless the user already picked a route.

### Audio routes

- **`setRoute('earpiece')` now means the receiver** on iOS too, when
  incall-manager has iOS routes (see below), as it already did on Android: it
  moves a call off a connected headset or car. For a speaker toggle use the
  new `setSpeakerOn(on)` on `useAudioRoute()` and `AudioRouteController`,
  whose "off" returns to the call's earlier or default route. A toggle
  written as `setRoute(route === 'speaker' ? 'earpiece' : 'speaker')` should
  switch to `setSpeakerOn(route !== 'speaker')`. `CallControls` uses it.
- iOS routes beyond speaker on/off need react-native-incall-manager with iOS
  audio routes (the upstream change, or
  `docs/patches/react-native-incall-manager+4.3.0.patch`). The package
  detects them at run time. With them: every route can be chosen, and `route`
  follows what iOS reports (the starting device, a headset or car connecting
  or dropping, the system route menu, CallKit's speaker button). Without
  them (released incall-manager): `'bluetooth'` is ignored with one warning
  instead of an unhandled rejection on every choice, and `'earpiece'` turns
  the speaker off.
- `useAudioDevices()` and `getAudioDeviceStatus()`: the devices available and
  the one iOS is playing through, by name. iOS with iOS routes only.
- A refused route (no such device) leaves `route` where it was.
- `AudioRouteController.setRoute` no longer takes a `force` argument.
- `stop()` makes no native call after `InCallManager.stop()`. It used to turn
  the speaker off afterwards, which after a video call switched the idle
  session to voice chat mode and turned the proximity sensor back on.
- `CallControls`' speaker button reads "Bluetooth" when the call is on a
  Bluetooth device.

### The system audio output button, natively

- **The package now ships a little native iOS code** (`ios/`, pod
  `SignalWireReactNative`): `AudioRoutePickerButton`, the system audio output
  button (`AVRoutePickerView`). It autolinks, but an app has it only after a
  native rebuild (`pod install`, or `expo prebuild` / `expo run:ios`); until
  then it renders nothing. It writes nothing to the audio session.
- `CallControls` shows it on iOS. `showRoutePicker` defaults to
  `showAudioRoute`, so an app that hid audio routing doesn't get it.

### CallKit outbound call names

- New `callKit={{ displayName: (destination) => string }}` on
  `SignalWireProvider` (React Native): the name CallKit and Recents show for an
  outbound call. The default is still the destination. Each call reads the
  latest prop. A `displayName` that throws or returns an empty string falls
  back to the destination, so the call placed by `dial()` is still tracked.
- `CallKitObserverOptions` is exported from `@signalwire/react-native/callkit`.
- `@signalwire/react`'s `SignalWireProvider` now binds an observer that
  arrives after the client was built (turning `callKit` on after mount), so it
  mirrors inbound calls too.

### CallKit audio timing

- CallKit audio starts as soon as the audio session is up: the bridge keeps
  CallKit's activation as state, so an outbound call (whose session CallKit
  activates before it connects) no longer waits out the 3 s fallback, and the
  answer-time and connect-time starts of one inbound call go together. A
  deactivation, a CallKit provider reset, or the bridge stopping a call's
  audio makes the next call wait for its own activation.
- No audio starts for a call that ended while it waited for the session,
  including a push the user answered and then ended before its SDK call
  existed.
- callkeep's launch buffer is replayed once and then cleared
  (`RNCallKeep.clearInitialEvents()`), so a JS reload doesn't replay an old
  answer or activation. `RNCallKeep.getInitialEvents()` resolves `[]` after
  that; an app's own `didLoadWithEvents` listener still receives the
  dispatch. A replayed answer or end for a launch push whose display event
  isn't in the buffer is held until `setup()` adopts that push, instead of
  being dropped.
- `CallKeepBridge.destroy()` removes only the bridge's own callkeep handlers,
  not every handler of each event type in the app.

## 0.1.0

First release. React Native support for `@signalwire/js` v4 — platform
adapters, a React API over the SDK's observables, native call UI, and push on
both platforms.

Verified on hardware and an emulator rather than only in unit tests: outbound
and inbound calls with audio, answering from a running **and** a killed app,
and hang-up propagating in both directions. See the support matrix in the
README.

### Packages

- `@signalwire/react` — provider and hooks, no platform code
- `@signalwire/react-native` — the above plus adapters, video view, CallKit /
  ConnectionService, audio routing, push
- `@signalwire/react-ui` — React wrappers for the SDK's Lit components
- `@signalwire/react-native-ui` — call controls, dialpad, participants, device
  picker, incoming-call sheet

### What this package does that the SDK cannot do alone

Six things break `@signalwire/js` under React Native; all are handled, and
three are import-time crashes:

- `window.dispatchEvent(new CustomEvent(...))` at import, behind a `typeof
  window` guard that React Native passes without having either symbol
- `new URL('destination:' + addr)` — RN's built-in `URL` drops the scheme
- `crypto.getRandomValues`, which Hermes does not have
- ES2022 static class blocks, untransformed by `babel-preset-expo` on SDK 52
- ES2025 iterator helpers on Map iterators — present in V8, absent in Hermes,
  and dormant until something touches the directory
- `RTCRtpSender.setStreams()` on the inbound-answer path, unimplemented by
  `react-native-webrtc`, which broke answering *after* the user accepted

### Inbound calling

Push wakes the device, the OS shows the call, and the app joins a caller
already parked on ringback — rather than racing an invite against a cold
start. The push carries a single-use token, never the call SID.

### Known gaps

- **Android draws no lock-screen call UI.** `backToForeground()` needs an
  unlocked device; a locked phone needs a full-screen-intent notification,
  not yet implemented.
- **A voice call forces speakerphone**, because the audio session mode is taken
  from the app's `supportsVideo` capability rather than the call's own media.
- **Screen sharing, audio level meters, `setSinkId`** — no React Native
  equivalent exists; see "Not supported, and why" in the README.

### Compatibility notes worth knowing before you install

- `@react-native-firebase` **v23+ requires the New Architecture**; this package
  targets legacy, so **v22 is the ceiling**. Gradle reports the mismatch as
  "daemon disappeared unexpectedly", which looks like an out-of-memory kill.
- Expo SDK 52 needs two build-config additions; SDK 53+ does not. See the
  README.
- Firebase's Expo plugin demands an iOS `GoogleService-Info.plist` whenever it
  is applied, even for Android-only push on a project where iOS uses PushKit.
