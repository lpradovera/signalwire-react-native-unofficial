# Changelog

## Unreleased

### Android call audio is routed by Telecom

Needs a native rebuild for the routes Telecom offers (the package's Android
library reads them); routing through Telecom works without it.

- A call the CallKit bridge tracks on Android is routed by Telecom, which
  holds it in callkeep's self-managed ConnectionService: `setRoute` and
  `setSpeakerOn` ask Telecom (callkeep's `setAudioRoute`), and `route`
  follows Telecom's `didChangeAudioRoute` (the system output switcher,
  Bluetooth connecting or dropping, a wired headset). incall-manager drove
  the route through AudioManager instead, so Telecom and incall-manager
  disagreed (Telecom kept EARPIECE while incall-manager forced the speaker),
  and nothing listened to Telecom's changes.
- incall-manager's session isn't started for such a call (its `start()`
  routes, whatever its `auto` flag); the package uses its screen-on and
  proximity calls instead. Telecom sets the audio mode and audio focus.
- Speaker off returns to the call's earlier route: the receiver, a wired
  headset or Bluetooth. A route Telecom doesn't offer goes back with a
  warning, and so does one Telecom doesn't move the call to within 2.5 s.
- A video call that Telecom starts on the receiver goes to the speaker, as
  incall-manager's start did.
- `AudioRouteController.start(media, call?)`: the CallKit bridge passes the
  call's uuid (internal). Without it, and for a call Telecom refused,
  incall-manager routes as before.
- New native module `SignalWireCallAudio` in the package's Android library:
  reads a callkeep call's `CallAudioState` (route, the routes Telecom offers,
  the Bluetooth device's name).
- The screen goes off at the ear on the receiver. A new native module,
  `SignalWireProximityScreen`, holds a `PROXIMITY_SCREEN_OFF_WAKE_LOCK`
  while the call's route is the earpiece, and the system blanks the screen
  when something is near, as the dialer does. It is released at once on the
  speaker, Bluetooth or a wired headset, and at the end of the call once the
  phone has left the ear. The screen used to go off only after JavaScript
  saw a "near" event from incall-manager's sensor listener and asked for the
  lock; on a Pixel 6 Pro (Android 17) it never went off. Without a native
  rebuild the sensor path still runs.

### Android calls: set active, permissions, foreground service, incoming-call notification

Needs a native rebuild: the package now has an Android library (autolinked).

- A connected call is set active in Telecom (`setCurrentCallActive`). The
  bridge reported connection only through callkeep's
  `reportConnectedOutgoingCallWithUUID`, which is a no-op on Android, so every
  answered incoming call stayed RINGING and every outgoing call DIALING
  (Android 16 disconnects such a call after about two minutes).
- `setup()` requests READ_PHONE_NUMBERS, RECORD_AUDIO, POST_NOTIFICATIONS
  (13+) and BLUETOOTH_CONNECT (12+) at runtime, once the app is on screen.
  Not CAMERA: react-native-webrtc's getUserMedia asks for it when a call first
  sends video, so an audio-only app with `supportsVideo` is never asked. callkeep requests nothing in
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

### Android call push works from the ES-module build and with React Native Firebase 22

- Android call push was off in every app that `import`s
  `@signalwire/react-native/callkit` (the example, the docs, any Expo app):
  that resolves to `dist/callkit.mjs`, where esbuild had turned the lazy
  Firebase `require` into its `__require` shim. Metro does not bundle what
  that shim names, so Firebase was never in the bundle, `registerAndroidCallPush()`
  registered nothing, and a later `getFcmToken()`/`watchPushToken()` from a
  React effect was a fatal JS error in a release build. The ES-module build
  now keeps a plain `require`, and `npm run verify` checks with Metro's own
  dependency collector that both builds hand Metro the same dependencies.
- The Firebase loader took React Native Firebase 22.x's `default` export, the
  namespaced `messaging()` function, which has none of the modular functions,
  so push was off from the CommonJS build too, on the version the example pins.
  It now reads the modular functions from the module itself.
- Firebase's JavaScript is evaluated only when its native modules are linked,
  so a build without them never runs it (a throw there is fatal outside an
  entry-file load). `registerAndroidCallPush()` and `watchFcmToken()` no
  longer throw on a build that links Firebase without a `google-services.json`.
- Firebase messaging is resolved once, while the package's push module loads,
  instead of on each use. A `require` from a React effect (`watchPushToken`)
  is outside every module load, where Metro reports a throw as fatal before
  any `catch` runs: a release build without Firebase configured died about
  half a second after launch with `Requiring unknown module
  "@react-native-firebase/messaging"`. Why push is off is logged once, at info.
- `getFcmToken()` (and so `watchPushToken()`) asks for `POST_NOTIFICATIONS` on
  Android 13 and later; React Native Firebase's `requestPermission` does not
  ask on Android.
- An Android push entry's `data` holds the push's extras only, as on iOS
  (`call_id`, `from` and `from_name` are the entry's own fields), and only the
  keys the server renamed for FCM lose their `sw_` prefix.
- Tests run the real React Native Firebase 22.4.0 JavaScript with its native
  side stubbed, including the headless task Android starts for a backgrounded
  or killed app.

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
  the controller, in every bundle copy of the package; it is released when
  the last of them unsubscribes, and a call's start reads the status once.
- A refused route (no such device) leaves `route` where it was: the route
  incall-manager last confirmed, also when the choice was held for the
  session (it used to "go back" to the held route itself) or other choices
  were still waiting for their answers (a refusal is matched to its own
  choice, not to the route shown, and one a later choice or write replaced
  changes nothing). On Android,
  where incall-manager answers a Bluetooth choice it can't make instead of
  refusing it, the answer's device list decides, and speaker-off falls back
  to the speaker off when the device it would return to is gone.
- A video call is no longer forced onto the loudspeaker at start: incall-
  manager's own start uses the speaker only when nothing else is connected,
  so a video call started with AirPods or in a car stays there.
- On Android `route` follows incall-manager's device reports
  (`onAudioDeviceChanged`): the device its start picked (a video call on a
  Bluetooth headset reads `'bluetooth'`, not `'speaker'`, so the speaker
  toggle turns the speaker on instead of taking the call to the earpiece),
  and a headset or car connecting or dropping. With iOS routes and on
  Android a route choice made after the session starts but before its
  first status (the start read, or Android's first report) is held until it
  arrives and applied to the route it reports; a held speaker-off then writes
  nothing when the call isn't on the speaker. With released incall-manager
  on iOS nothing reports: a video call reads `'speaker'` (incall-manager's
  default) even when iOS kept it on a headset or car, and the toggle's
  first tap there is speaker off, which incall-manager implements as voice
  chat mode for a video call.
- `setSpeakerOn(false)` on Android returns a voice call to incall-manager's
  default (a connected headset or car, else the receiver) instead of
  forcing the receiver, which Android then preferred over the headset; a
  video call (whose default is the speaker) still gets speaker off.
- Speaker-off returns a call to a headset or car the speaker had replaced at
  incall-manager's default instead of forcing "speaker off", which in a
  video call meant voice chat mode on the headset and the receiver once it
  left.
- With CallKit, a route chosen before the call's session starts (a tap while
  an outbound call rings) is shown at once and applied when it starts;
  nothing native is written for it before then. Turning the speaker off
  again before the session starts is held too, so a video call then starts
  off the speaker. A choice is held only while a call the CallKit bridge
  tracks is live: when the last one ends without a session (an outbound
  call nobody answered, a push that never got its call) the choice is
  dropped and `route` goes back to `'earpiece'`, so the next call doesn't
  start with it, and a call the bridge doesn't track (the provider's
  `callKit` off) is treated as having no session. A held choice survives
  the `stop()` of another call's session while a call that will start one
  is still live; nothing else of an ended session carries into the next
  `start()`.
- With no session (an app without CallKit that doesn't call
  `AudioRouteController.start()`, or an untracked call), only what
  incall-manager can do without one is written and shown: on iOS speaker on
  and off (`'earpiece'` is speaker off), while `'headset'` and
  `'bluetooth'` are ignored with one warning instead of being shown and not
  sent; on Android nothing, with one warning, because a never-started
  incall-manager refuses every route (as it did on main, where the speaker
  button changed only its label). `getAudioRouteController().start(media)`
  and `stop()` around a call give an app without CallKit the full routing.
- A late answer or report from an ended call no longer reaches the next one,
  and the status the next call starts from is read after its session
  starts, not taken from the previous call.
- `AudioRouteController` checks that incall-manager's native module is
  linked: in an app installed without a rebuild its constructor throws
  `MissingPeerDependencyError`. The CallKit bridge still logs one warning per
  call there, now `Audio routing unavailable: MissingPeerDependencyError ...`
  (it was `Failed to start the audio session:` with a TypeError), and the
  call runs without routing. `useAudioRoute()` logs that error and returns
  `'earpiece'` with setters that do nothing, so `CallControls` (which calls
  it even with the speaker button hidden) still renders.
- `AudioRouteController.setRoute` no longer takes a `force` argument.
- `stop()` makes no native call after `InCallManager.stop()`. It used to turn
  the speaker off afterwards, which after a video call switched the idle
  session to voice chat mode and turned the proximity sensor back on.
- `CallControls`' speaker button reads "Bluetooth" when the call is on a
  Bluetooth device.

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
