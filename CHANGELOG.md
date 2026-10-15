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

### iOS audio routes, and native code in `@signalwire/react-native`

- **The package now ships native iOS code** (`ios/`, pod
  `SignalWireReactNative`). It autolinks, but an app has it only after a native
  rebuild: `pod install`, or `expo prebuild` / `expo run:ios`.
- Earpiece and Bluetooth routes work on iOS. `react-native-incall-manager` has
  no iOS `chooseAudioRoute` (through 4.3.0), so every iOS Bluetooth choice
  used to be an unhandled rejection; iOS now uses the package's own module.
  Android still uses incall-manager.
- `useAudioDevices()`, `getAudioDeviceStatus()` and
  `addAudioDeviceChangeListener()`: the routes available and the one iOS is
  playing through, by name, kept current as headsets and cars come and go.
- `AudioRoutePickerButton`: the system audio output button
  (`AVRoutePickerView`). `CallControls` shows it on iOS (`showRoutePicker`).
- On iOS `useAudioRoute().route` follows the route iOS settled on: a choice in
  the system picker, or a headset or car connecting or dropping. The speaker
  toggle stays in step with it.
- `setSpeakerOn(on)` on `useAudioRoute()` and `AudioRouteController`: speaker
  off returns to the call's earlier or default route (a connected headset or
  car), where `setRoute('earpiece')` pins the receiver. `CallControls` uses it.
- iOS ownership of the audio session is split cleanly: incall-manager keeps the
  category, mode and speaker override (its force-speaker flag, which every
  route now sets to match); the package's module only picks the device off the
  speaker.

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
