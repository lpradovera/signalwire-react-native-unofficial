# Changelog

## Unreleased

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
  being dropped; so is a live answer or end that arrives while `setup()` is
  still fetching that push. A held answer whose push is never adopted (the
  launch cache keeps only the last of several pushes) expires after the
  fusion timeout and its CallKit call is ended as missed, instead of staying
  answered with nobody on it.
- `CallKeepBridge.destroy()` removes only the bridge's own callkeep handlers,
  not every handler of each event type in the app. On callkeep 4.3.0-4.3.8,
  whose `addEventListener` returns nothing, it reads each handler's
  subscription back from callkeep as it is added, so it removes them there
  too.
- A CallKit provider reset (callservicesd restarting, say) ends every live
  call as a native end would: its SDK call is hung up, a ringing push is
  turned down, and the audio session is stopped. CallKit sends no endCall
  action for the calls it drops, so before this they stayed live in the
  registry and the next call found the session still started for them.

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
