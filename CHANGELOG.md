# Changelog

## Unreleased

### Packaging

- **Version 2.0.0-alpha.0, on npm's `alpha` tag.** The four packages are
  versioned together; `@signalwire/react-native` depends on
  `@signalwire/react`, and `@signalwire/react-native-ui` takes both as peers,
  at `^2.0.0-alpha.0`. They are
  on their way to becoming SignalWire's supported React Native SDK, as the
  next major of `@signalwire/react-native` after the 1.x SDK
  (signalwire-node); `latest` and `next` stay on 1.x until 2.0.0, and
  `alpha` moves from the 1.x line's 1.1.0-alpha.4 to this one. Install with
  `npm install @signalwire/react-native@alpha`. Each package's
  `publishConfig` sets the tag, and `npm run verify:package` checks the
  packed manifests. RELEASING.md has the steps.

### Compatibility

- **New Architecture only.** The packages support React Native's New
  Architecture (the default since React Native 0.76) and no longer the old
  one, which React Native 0.82 removes. The example app runs on it
  (`newArchEnabled: true`); react-native-webrtc, react-native-callkeep and
  react-native-incall-manager run through React Native's interop layer. An
  app with `newArchEnabled: false` should move before upgrading.
- With the old architecture gone, `@react-native-firebase` v23+ (which
  requires the New Architecture) is no longer ruled out; the example stays on
  v22.4.0, the verified line.

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
  it reads the media from the call, falling back to `supportsVideo` for a call
  without `mediaDirections`.

### Audio routes

- **New route `'headset'`** in `AudioRoute`, for a wired or USB-C headset,
  which used to read as `'earpiece'`. The four routes match
  incall-manager's four devices one to one (EARPIECE, SPEAKER_PHONE,
  WIRED_HEADSET, BLUETOOTH; incall-manager reports USB audio as a wired
  headset and a car as Bluetooth). `setRoute('headset')` chooses the headset
  (`chooseAudioRoute('WIRED_HEADSET')`) with iOS routes and on Android, and
  turns the speaker off with released incall-manager on iOS. A
  `switch (route)` or a `Record<AudioRoute, ...>` needs the new case;
  `CallControls` labels it "Headset".
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
  the one iOS is playing through, by name. iOS with iOS routes only. They
  follow headsets and cars while a call's session runs; outside a call they
  hold the last status read. One native subscription serves every hook and
  the controller, in every bundle copy of the package.
- A refused route (no such device) leaves `route` where it was. On Android,
  where incall-manager answers a Bluetooth choice it can't make instead of
  refusing it, the answer's device list decides, and speaker-off falls back
  to the speaker off when the device it would return to is gone.
- A video call is no longer forced onto the loudspeaker at start: incall-
  manager's own start uses the speaker only when nothing else is connected,
  so a video call started with AirPods or in a car stays there.
- Speaker-off returns a call to a headset or car the speaker had replaced at
  incall-manager's default instead of forcing "speaker off", which in a
  video call meant voice chat mode on the headset and the receiver once it
  left.
- With CallKit, a route chosen before the call's session starts (a tap while
  an outbound call rings) is shown at once and applied when it starts;
  nothing native is written outside a session. Turning the speaker off
  again before the session starts is held too, so a video call then starts
  off the speaker. Without CallKit, speaker on/off still works outside a
  session, as before.
- A late answer or report from an ended call no longer reaches the next one,
  and the status the next call starts from is read after its session
  starts, not taken from the previous call.
- `AudioRouteController` checks that incall-manager's native module is
  linked (an app installed without a rebuild gets `MissingPeerDependencyError`
  instead of a warning on every call).
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
- `AudioRoutePickerButton` takes a background, corner radius and padding in
  its own `style` (the padding insets the icon), so `CallControls` styles
  the button as a pill with no wrapper view.
- The button shows only with incall-manager's iOS routes (the upstream
  change, or `docs/patches/`), and `isAudioRoutePickerAvailable()` says so.
  Released incall-manager 4.3.0 neither reports a choice made there nor
  keeps it, so on 4.3.0 it renders nothing and `CallControls` offers speaker
  on/off.
- VoiceOver reads the button as one element, a button with its
  `accessibilityLabel` (default "Audio output"); before, it read AVKit's
  inner "AirPlay" button and the label went unused. `activeTintColor` is
  AVKit's AirPlay-active colour, which a headset or car doesn't trigger, so
  `CallControls` no longer passes one.

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
  session CallKit was handing over. A call takes over an ended owner's
  session only when it is taking the session itself (answered, placed or
  connected): it keeps the route when the session was started for its media,
  and gets the session restarted for its own media otherwise, after its own
  activation. A call that is only ringing doesn't keep the session up: when
  the owner ends and no call is accepted within a second, the session is
  stopped, and the ringing call gets a session of its own if it is answered
  later.
- A CallKit provider reset releases the session at once, with the calls it
  drops (a ringing push included), and the next call owns a session of its
  own.
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
