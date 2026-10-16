# Changelog

## Unreleased

### The incoming-call sheet clears the navigation bar, and can skip the Modal

- `IncomingCallSheet` pads its bottom by the safe-area inset, so Decline and
  Answer are clear of the home indicator and of Android 15+'s edge-to-edge
  navigation bar. It brings its own `SafeAreaProvider`, because a `Modal` is
  a window of its own that the app's provider does not reach (found and
  tested on a Pixel 6 Pro by Len Graham).
  `react-native-safe-area-context` (>=4.0.0) is a new peer dependency of
  `@signalwire/react-native-ui`.
- New `CallOverlayHost`: mounted as the last child of the root view, the sheet
  draws in it instead of in a `Modal`. A host mounted inside one of the app's
  own Modals takes over while it is open. Without a host, the sheet still uses
  a `Modal`. The setup docs recommend mounting it, and the example does.

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

### CallKit outbound call names

- New `callKit={{ displayName: (destination) => string }}` on
  `SignalWireProvider` (React Native): the name CallKit and Recents show for an
  outbound call. The default is still the destination. Each call reads the
  latest prop. A `displayName` that throws or returns an empty string falls
  back to the destination, so the call placed by `dial()` is still tracked.
- `CallKitObserverOptions` is exported from `@signalwire/react-native/callkit`.
- `@signalwire/react`'s `SignalWireProvider` now binds an observer that
  arrives after the client was built (turning `callKit` on after mount), so it
  mirrors inbound calls too, and unbinds one that is replaced or removed.
  `CallObserver.bindClient` may return a function that undoes the binding;
  the provider calls it when the observer changes or goes away, the client is
  replaced, or the provider unmounts. `bindClient` runs again for each new
  observer object, so memoize an observer that returns an unbind. One that
  returns nothing, as 0.1.0 observers do, is still bound once per client: its
  binding can't be undone, so the provider doesn't bind a re-created (inline)
  observer again on top of it.
- Turning `callKit` off stops CallKit from showing the client's inbound
  calls (`CallKeepBridge.bindClient` returns its unbind). A client is
  subscribed to once however often it is bound, and stays bound until every
  binder has unbound it: two providers, or a provider and the app's own
  `getCallKit().bindClient(client)`, no longer unbind each other.

### Readable caller names in the incoming-call sheet

- `IncomingCallSheet` no longer shows the backend's `_undef_` placeholder or
  a raw Fabric address / SIP URI as the caller: `/private/rn-device-test`
  shows as `Rn Device Test`, and a call with no usable name or handle shows
  "Unknown caller".
- New `displayableName(name)` on `@signalwire/react-native` (and
  `@signalwire/react-native/ringing`): the same naming CallKit uses, for apps
  that draw their own call UI.

### Caller names with a SIP scheme

- `displayableName` (and so CallKit, Telecom and the incoming-call sheet)
  drops a leading `sip:` / `sips:` even when what follows is not a URI user
  part. A REST `caller_id` of `Android Test` reached the app as
  `fromName: "sip:Android Test"` and was shown that way; it now shows
  `Android Test`. A SIP URI with a user part is still shown by its user part.

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
