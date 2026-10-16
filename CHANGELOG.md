# Changelog

## Unreleased

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
  `showAudioRoute`, so an app that hid audio routing doesn't get it. With the
  fifth control the bar wraps onto a second row where one row doesn't fit
  (a screen narrower than about 410 pt at the default text size, which is
  most iPhones, and wider ones at large Dynamic Type sizes), instead of
  pushing Mute and End off both screen edges.
- **Upgrading tests and stand-ins:** `CallControls` now renders
  `AudioRoutePickerButton` and calls `useAudioRoute().setSpeakerOn`, so a jest
  mock of `@signalwire/react-native/audio` that provides only `useAudioRoute`
  returning `{ route, setRoute }` (the 0.1.0 shape) must add
  `AudioRoutePickerButton` (a component; `() => null` will do) and
  `setSpeakerOn`. `setSpeakerOn` is a required member of
  `UseAudioRouteResult`, so a typed stand-in needs it too.
- `AudioRoutePickerButton` takes a background, border, corner radius and
  padding in its own `style` (the padding insets the icon), so `CallControls`
  styles the button as a pill with no wrapper view. The style is drawn once,
  on the view around the native picker (it used to be applied to the picker
  as well: a translucent background doubled, a border drew two rings, opacity
  was squared), and a tap anywhere in that view, padding, border and
  `hitSlop` included, opens the menu (only the area inside the padding did).
- The button shows only with incall-manager's iOS routes (the upstream
  change, or `docs/patches/`), and `isAudioRoutePickerAvailable()` says so.
  Released incall-manager 4.3.0 neither reports a choice made there nor
  keeps it, so on 4.3.0 it renders nothing and `CallControls` offers speaker
  on/off.
- VoiceOver reads the button as one element, a button (`accessibilityRole`,
  default `'button'`) with its `accessibilityLabel` (default "Audio
  output"); before, it read AVKit's inner "AirPlay" button and the label went
  unused. `aria-label`, `aria-hidden`, `aria-disabled` and `id` work as on
  `View`. `activeTintColor` is
  AVKit's AirPlay-active colour, which a headset or car doesn't trigger, so
  `CallControls` no longer passes one.

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
