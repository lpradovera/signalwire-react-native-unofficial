# Changelog

## Unreleased

### Pushed calls: UUID case, duplicates, one dial per answer, declines, end reasons

- A pushed call whose UUID is upper-case (the native hook's own
  `[[NSUUID UUID] UUIDString]` when the payload has no `uuid`, or a backend
  that sends one) works: callkeep reports every CallKit action lower-cased,
  and the registry now keys on the lower-case UUID, so answer, end, hold,
  DTMF and mute find the call.
- A push for a call the registry already has (its SDK invite arrived first)
  shows no second native call; a PushKit display of such a call is ended at
  once as a duplicate.
- One answer places one call: `answerRequested$` delivers each answer once
  (replayed only to the first subscriber when none was there), answering
  twice asks once, `bindCall()` refuses a second call for an entry that has
  one, and a bridge dial whose entry ended or already has its call is hung
  up instead of being reported as a new outgoing call.
- New `CallRegistry.rejectRequested$`: a decline of a push with no SDK call
  (the parked-caller flow), so the app can tell its server. The example
  posts it to the support server's `POST /swml/decline`.
- End reasons from callkeep's per-platform table: a missed push is
  UNANSWERED on iOS (callkeep's MISSED is remoteEnded there) and MISSED on
  Android; `registry.endCall(uuid, 'failed')` and an answered push that
  never gets its call end as FAILED; a declined push is ended at once
  through `rejectCall` instead of ringing until the deadline and being
  reported missed.
- `setup({ fusionTimeoutMs })` takes effect (it was dropped); the default
  is 45 s, not the 20 s the JSDoc said.
- An empty caller name (a push's `from_name: ""`, an empty
  `caller_id_name`) is no name: the call is shown by its number, and a call
  with no name at all is too, instead of 'Unknown caller'.

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
