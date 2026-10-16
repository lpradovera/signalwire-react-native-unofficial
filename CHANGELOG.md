# Changelog

## Unreleased

### Android calls: set active, permissions, foreground service, incoming-call notification

Needs a native rebuild: the package now has an Android library (autolinked).

- A connected call is set active in Telecom (`setCurrentCallActive`). The
  bridge reported connection only through callkeep's
  `reportConnectedOutgoingCallWithUUID`, which is a no-op on Android, so every
  answered incoming call stayed RINGING and every outgoing call DIALING
  (Android 16 disconnects such a call after about two minutes).
- `setup()` requests READ_PHONE_NUMBERS, RECORD_AUDIO, CAMERA (with
  `supportsVideo`), POST_NOTIFICATIONS (13+) and BLUETOOTH_CONNECT (12+) at
  runtime, once the app is on screen. callkeep requests nothing in
  self-managed mode, so `additionalPermissions` never asked, and without
  READ_PHONE_NUMBERS the first incoming call killed the app with a
  SecurityException in `VoiceConnectionService.createConnection`.
- The ConnectionService's foreground-service types are `phoneCall|microphone`
  (was `camera|microphone` without FOREGROUND_SERVICE_CAMERA, which Android 14+
  refuses outright, so no call ever ran as a foreground service), with
  FOREGROUND_SERVICE_PHONE_CALL declared. An earlier prebuild's declaration is
  corrected. The ongoing-call notification gets a small icon
  (`androidNotificationIcon`, default `ic_launcher`).
- A call to a backgrounded or killed app rings: when Telecom asks for
  incoming-call UI, the bridge posts a call notification (CallStyle, its own
  ringing channel, Answer and Decline through the Telecom connection) whose
  full-screen intent opens the app over the lock screen while a call rings or
  runs. Not posted while the app is on screen. `bringToForeground()` no longer
  starts the activity from the push's headless task (a background activity
  start) when the library is linked. New options: `androidIncomingChannelName`.
- A call Telecom refuses (`createIncomingConnectionFailed`) is answered and
  rejected in the app through the SDK; a refused push with no call is ended.
- The plugin declares BLUETOOTH_CONNECT, so incall-manager sees Bluetooth
  headsets on Android 12+.
- `verify:prebuild` matches whole `uses-permission` elements and checks the
  ConnectionService declaration (guard, exported, foreground-service types).

### CallKit audio belongs to its call

- The audio session belongs to the call it was started for. Another call
  ending (a waiting call whose caller gives up, or one the user declines)
  no longer stops the live call's session, and a call ended with End &
  Accept no longer stops the next call's session when its own teardown
  finishes late.
- The session is released when its call ends by any path, including
  `registry.endCall()` (the example calls it when a bridge dial fails) and an
  answered push that never gets its call. Before, those left the session
  running in the idle app and the next call's audio start was ignored.
- A push the user answers and then ends in CallKit before its SDK call
  exists gets no audio, or has its audio stopped, and `bindCall()` /
  `bindBridgeCall()` refuse it, so a bridge call placed for it is hung up
  instead of joining the caller. New `CallRegistry.isLive(uuid)` tells an
  app's bridge hook whether to dial at all.
- `CallKeepBridge.destroy()` releases the session it started.
- With End & Accept the session is handed to the accepted call instead of
  being stopped: CallKit sends the ended call's endCall before the accepted
  call's answerCall, and incall-manager's `stop()` there deactivated the
  session CallKit was handing over. Whenever the owner ends while another
  call is live, the next call to start audio takes the session as it is
  (route and mode included), and it is stopped once no live call is left.
- A CallKit provider reset ends every live call as a native end would: its
  SDK call is hung up, a ringing push is turned down, and the session is
  released. CallKit sends no endCall action for the calls it drops.
- `bindBridgeCall()` on a call already bound to the entry (trackCall's claim
  binds it, and the app binds it again after the dial) does nothing, so the
  call is watched once: one connected report, one audio start, one end.

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
