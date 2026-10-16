# Changelog

## Unreleased

### CallKit voice and video

- An outbound call's CallKit type and audio session mode follow its own
  media (`call.mediaDirections`, the SDK's answer once preferences,
  `?channel=`, the dial options and a disabled camera are applied). A voice
  call starts on the receiver, or on a connected headset or car, instead of
  the loudspeaker. This corrects the 0.1.0 known gap "A voice call forces
  speakerphone".
- An SDK inbound call is a voice call: the registry answers every one of them
  audio-only (an in-app answer included, since it goes through CallKit), so
  CallKit shows it as voice and its audio starts on the receiver, whatever the
  caller offered. Its `mediaDirections` isn't used: @signalwire/js reports
  video for any offer whose m=video sends.
- A pushed call answered before its SDK call exists has no media yet. iOS
  shows every VoIP push as a voice call, and so does a push reported from
  JavaScript. Its audio session starts when its call (or the bridge call
  placed for it) connects, with that call's media; on iOS a video bridge call
  also turns the CallKit entry into a video call (callkeep's `updateDisplay`)
  when the caller's handle is a phone number. updateDisplay always re-sends
  the handle as a phone number, so for a `sip:` or Fabric caller the entry
  stays shown as voice rather than turn that address into a phone number in
  CallKit and Recents.
- A call is reported to CallKit as video only when the provider was set up
  with `supportsVideo: true`.
- `CallKeepBridge.trackCall(call, handle, displayName)` keeps its signature;
  it reads the media from the call. A call without `mediaDirections` (an
  older SDK, a destroyed call) is a voice call: `supportsVideo` only lets
  CallKit or Telecom show a video call as video, and never makes a call one,
  so an app with `supportsVideo: true` no longer starts voice calls on the
  loudspeaker or reports them to Telecom as video.

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
