# Changelog

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
