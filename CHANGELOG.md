# Changelog

## Unreleased

### Calling with Siri

- New plugin option `enableSiri` (default `false`): adds `INStartCallIntent`
  to `INIntentsSupported`, `NSSiriUsageDescription` (option
  `siriPermission`) and the `com.apple.developer.siri` entitlement, and
  generates `SignalWireSiriCallIntent.m`, the AppDelegate's
  `application:handlerForIntent:` (in-app intent handling, no Intents
  extension). "Call <name> with <app>" and "call back" resolve against the
  app's recent callees and reach `startCallRequested$` through the Recents
  forwarder. Needs a paid Apple team, `UIApplicationSupportsMultipleScenes`
  and Siri permission; see docs/native-setup.md.
- The bridge donates each connected call to Siri when it ends
  (`INInteraction`, `INStartCallIntent`, the remote party's name and handle):
  `CallKitSetupOptions.donateCallsToSiri`, default `includesCallsInRecents`.
- New `requestSiriAuthorization()`, `getSiriAuthorization()`,
  `forgetSiriCalls()` and `donateCompletedCall()` in
  `@signalwire/react-native/callkit`; new iOS pod files `SWSiriCalls`,
  `SWSiriCallStore`, `SWSiriCallIntentHandler` (the pod now links Intents).
- Docs: Recents call-back alone never made Siri work; native-setup.md said it
  did.
- Example: `enableSiri`, multiple scenes, and a Siri permission request at
  launch.

### Android: the microphone stays live in the background without CallKit

- With `callKit` off, `SignalWireProvider` runs a `microphone` foreground
  service on Android while a call is in progress (placed, or answered) and
  stops it when none is. From Android 14 a background app records silence
  without one, so a plain WebRTC call muted the user when the screen locked
  or the app went to the background (react-native-webrtc #1774, #1780;
  react-native-incall-manager #204, #208). Calls under `callKit` keep the
  ConnectionService's own. The library manifest declares the service
  (`com.signalwire.reactnative.CallForegroundService`) and
  `FOREGROUND_SERVICE_MICROPHONE`, so a native rebuild picks it up with no
  app change. See docs/native-setup.md, "Android: calls without the native
  call UI".
- Docs: `BLUETOOTH_CONNECT` (Android 12+) has to be granted at runtime;
  `setup()` asks for it with `callKit`, an app without it must ask itself.
- Example: `EXPO_PUBLIC_SW_CALLKIT=0` builds it without the native call UI.

### Call waiting, the same on iOS and Android

- **New default, `callWaiting: 'full'`** (`getCallKit().setup()`), on both
  platforms: a call that comes in during a call rings, with Hold & Accept, End
  & Accept and Decline; the two calls swap, and either can be ended; dialling
  during a call puts the live one on hold. Two calls at most: a third incoming
  call is refused as busy, a third dial throws `CallInProgressError`. CallKit
  is set up with `maximumCallGroups: 2`.
- **Behaviour change.** Before, iOS behaved as `'endAndAccept'` (CallKit's End
  & Accept) and Android as `'single'` (a second incoming call refused as
  busy), and a second dial threw `CallInProgressError` on both. Apps that want
  either keep it with `callWaiting: 'endAndAccept'` or `'single'`, which now
  behave the same on both platforms.
- New `useCalls()`: the calls in progress, `activeCall`, `heldCalls`,
  `isHeld`, `hold`, `unhold` (holds the active call first) and `swap`.
- `useIncomingCalls().answer()` puts a call in progress on hold first (Hold &
  Accept); new `endAndAnswer()` ends it first (End & Accept).
- `useSignalWire().dial()` puts a call in progress on hold first, and takes it
  off hold again if the new call can't be placed.
- New `getCallHoldState()`: one hold state per call. @signalwire/js rc.5 only
  has `toggleHold()`, which flips a private flag, so a hold from CallKit,
  Telecom or the app is compared with the state first and the requests for a
  call run one at a time. CallKit's `didToggleHoldCallAction` used to toggle
  blindly.
- `CallObserver.onIncomingAnswer(call, others)` gets `'hold'` or `'end'`, and
  new `onHoldChange(call, held)` lets the native call UI mirror an in-app
  hold.
- `IncomingCallSheet` shows over a call in progress, with Hold & Accept, End
  & Accept and Decline (End & Accept and Decline in `'endAndAccept'`). On
  Android, where Telecom draws nothing, a second call used to ring with
  nothing on screen.
- The audio session follows the active call: a held call keeps it alive for
  the other, and on Android the active call's Telecom connection routes it.
- `CallRegistryOptions.callLimit` (and `registry.setCallLimit()`) replaces
  the Android-only `refuseIncomingWhileBusy`, which still works (limit 1).
- `CallInProgressError` is thrown only outside `'full'`, or for a third call.

### Back keeps the call running (Android)

- **New default:** `CallKitSetupOptions.endCallsOnHostDestroy: false`. Back
  on the root screen (or the app swiped away) no longer ends the call: callkeep
  keeps its connection, and the ongoing-call notification brings the app back
  to the call. `true` restores the old behaviour (Back ends the call cleanly).
- New `SignalWireProvider` prop `keepCallsOnUnmount` (core; the React Native
  provider turns it on with native call UI unless `endCallsOnHostDestroy`):
  a provider that unmounts during a call keeps its client and calls for the
  next provider to take back, instead of hanging up. A client whose calls all
  end while it is kept is torn down.

### callkeep: `@signalwire/react-native-callkeep`, or stock

- The package loads callkeep as `@signalwire/react-native-callkeep` (the
  SignalWire-maintained fork, preferred) or, when that is not installed, as
  stock `react-native-callkeep`. Both are optional peers. The choice is made
  once, while the bridge's module loads; an app with neither still bundles,
  and the native call UI's `setup()` throws `MissingPeerDependencyError`
  naming the fork (and stock callkeep as the alternative), with the reason when
  an installed callkeep failed to load.
- The Expo config plugin generates the iOS VoIP push hook when either name is
  installed.
- Install `@signalwire/react-native-callkeep`. Stock callkeep works but lacks
  the fork's fixes: on Android, 4.3.16 crashes at launch on the New
  Architecture. Until the fork is on npm, install it from
  `github:signalwire/react-native-callkeep#v4.4.0`. Apps that import
  callkeep themselves change the import to `'@signalwire/react-native-callkeep'`.

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


### Calling back from Recents and Siri

- `CallKitSetupOptions.includesCallsInRecents` (iOS, default `true`, which is
  CallKit's default too).
- New `getCallKit().startCallRequested$`: a `StartCallRequest` (`handle`,
  `displayName`, `video`) each time the user calls back from Recents or Siri,
  from callkeep's `didReceiveStartCallAction` (also when it is replayed at a
  cold start, held for the first subscriber for up to a minute). CallKit's
  echo of the app's own outbound calls is left out. The example dials from it.
- The Expo plugin (with `enableCallKit`) generates
  `SignalWireCallKitActivity.m`, which forwards the AppDelegate's
  `continueUserActivity` (`INStartCallIntent`) to RNCallKeep the way the
  PushKit hook is generated, and declares the call intents in
  `NSUserActivityTypes`. Without it callkeep never received the activity.

### One call at a time: a second dial is refused

- With `callKit`, `dial()` rejects with the new `CallInProgressError`
  (exported from `@signalwire/react-native` and `/callkit`, with the live
  call's `liveCallUuid`) while another call is live, a ringing push
  included, before the SDK places anything. CallKit is set up for one call
  (`maximumCallGroups: 1`) and refuses a second start transaction, which
  callkeep only logs, so the second call ran with no native UI and the
  registry held an entry CallKit never had. A bridge dial for an answered
  push is not refused.
- New `CallKeepBridge.assertCanDial()`, and `trackCall()` hangs up and throws
  `CallInProgressError` for a second call that gets past it (two dials
  racing): the registry never holds a call CallKit refused.
- New optional `CallObserver.beforeOutgoingCall(destination)` in
  `@signalwire/react`: `dial()` calls it first, and a throw refuses the dial.
- On Android, an incoming call while another call is live (a ringing one
  included) is refused as busy and not shown: the SDK call is rejected
  (`reject()`, a `verto.bye` with `USER_BUSY`, SIP 486), and a push for it is
  not reported to Telecom, so its SDK call is rejected when it arrives.
  Telecom held such a call RINGING with nothing on screen, so it rang where
  nobody could see or answer it. iOS is unchanged: CallKit shows a second
  call with its own End & Accept and Decline.
- Example: `EXPO_PUBLIC_SW_DEV_DIAL_AGAIN=<address>` adds a dev-only
  "Dial again" button to the call screen, which shows the second dial being
  refused.

### `fetchToken`: tokens that renew themselves (alpha)

- New `fetchToken` prop on `SignalWireProvider` (`@signalwire/react` and
  `@signalwire/react-native`): `() => Promise<{ token, expiresAt? }>`. The
  client connects with it, `expiry_at` is set from `expiresAt` (Unix seconds,
  milliseconds or ISO 8601), and `@signalwire/js`'s `refresh()` is wired to
  it. The token is renewed a fifth of its lifetime before expiry (10–60 s),
  on foreground and on a call push when near or past expiry; failures retry
  with a capped backoff (1 s doubling to 30 s); a 401 or 403 stops and is
  reported. See `docs/tokens.md`.
- Each renewal is logged at info, without the token.
- New `useSignalWire().tokenStatus` (`'fetching' | 'ready' | 'renewing' |
  'retrying' | 'unauthorized'`, with `expiresAt` and `error`; `null` with a
  `credentialProvider`), `TokenFetchError`, and the types `FetchToken`,
  `FetchedToken`, `TokenState`, `TokenStatus`. The context gains optional
  `tokenStatus` and `renewTokenIfDue`; `SignalWirePlatform` gains an optional
  `watchForeground`, which `createReactNativePlatform()` implements with
  `AppState`.
- `credentialProvider` is now optional (pass it or `fetchToken`). Apps that
  pass one are unchanged.
- Example server: `POST /token` mints with an expiry (`TOKEN_TTL_SECONDS`,
  default 7200) and returns `expires_at`. The example app uses `fetchToken`.

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
  "@react-native-firebase/messaging"`. Why push is off is logged once per run,
  as a warning (the logger's default level hides info in release builds),
  including on a build whose Firebase has no default app, where it was logged
  again each time the push token was watched.
- `getFcmToken()` (and so `watchPushToken()`) asks for `POST_NOTIFICATIONS` on
  Android 13 and later; React Native Firebase's `requestPermission` does not
  ask on Android.
- An Android push entry's `data` holds the push's extras only, as on iOS
  (`call_id`, `from` and `from_name` are the entry's own fields), and only the
  keys the server renamed for FCM lose their `sw_` prefix.
- Tests run the real React Native Firebase 22.4.0 JavaScript with its native
  side stubbed, including the headless task Android starts for a backgrounded
  or killed app.

### React Native: an unlinked WebRTC, session secrets, stale errors, empty caller names

- An installed but unlinked `react-native-webrtc` (a dev client not rebuilt)
  throws `MissingPeerDependencyError` naming the rebuild, from
  `createWebRTCApiProvider()` or the first `SignalWireVideoView` render. It
  used to crash the app's entry file on import, before the guard ran (which
  checked a member the JS object always has).
- The storage adapter keeps the SDK's session scope in memory for the life
  of the process. It used to write it, the cached SAT and the session-resume
  `authorization_state` included, to plaintext AsyncStorage until the next
  launch purged it. Session keys an earlier version wrote are still purged.
- A connection error on `useSignalWire().error` (`WebSocketConnectionError`,
  `WebSocketTimeoutError`, `TransportConnectionError`) is cleared each time the
  client registers again, so a dropped socket the SDK reconnected no longer
  shows as a current failure for the rest of the session. Any other error
  stays until the next one replaces it. (The fix from fix/react-error-clears.)
- `IncomingCallSheet` treats an empty caller name as no name and shows the
  number, then 'Unknown caller'.

### CallKit setup

- Overlapping `setup()` calls share one handshake. The guard was read before
  the first await and set after it, so two calls in one run (two effects in
  one commit, StrictMode) both registered every listener, and each answer,
  DTMF digit and hold was delivered twice. A failed setup can be retried.
- Every CallKit listener is registered when the bridge is created, not in
  `setup()`. On iOS the first listener starts callkeep's observing, after
  which callkeep sends actions live instead of buffering them, so an answer or
  an end made between `getCallKit()` and a later `setup()` was lost.
- `setup()` checks callkeep's native module rather than its JS wrapper, which
  always has `setup`: an installed but unlinked callkeep now throws
  `MissingPeerDependencyError` instead of a TypeError, here and later from
  every outbound call.

### A call CallKit refused to show

- When CallKit refuses an incoming call (a Focus mode that does not allow the
  caller, the block list), the app's own Accept and Decline go straight to the
  SDK. They asked CallKit to answer a call it did not have, which failed
  silently, so they did nothing. A refused push is not adopted as a ringing
  push, and a push entry the app reported is ended.

### CallKit actions do what the user asked

- A transient `'disconnected'` (an ICE blip, Wi-Fi to cellular) no longer
  ends the CallKit call. The SDK recovers from it, and ending the native call
  there left a connected call with no CallKit UI and no audio session. A call
  that does not recover ends `'failed'`. The example's call screen stays up
  through it too.
- The app's own hangup ends the CallKit call at once (`'disconnecting'`),
  instead of after the bye settles, up to its 5 s timeout.
- CallKit's hold carries the state it wants, and the bridge applies that
  state instead of toggling: an in-app hold, a failed hold RPC, or a hold and
  resume sent together no longer invert every later native hold. Requests for
  one call run in order, and a failed one tells CallKit the real state
  (`setOnHold`). A failed hold is no longer an unhandled rejection.
- A CallKit mute made before the call has a self participant (while a bridge
  call is being placed, or before an SDK call is joined) is applied when the
  participant appears, instead of being dropped while CallKit shows Mute on.
- Declining a ringing inbound SDK call in CallKit, or in the app through
  `rejectIncomingFromApp`, rejects it (`verto.bye` USER_BUSY), as it does with
  callKit off, instead of hanging it up with no cause.
- `trackCall()` for a call it already tracks returns its uuid and does not
  watch it a second time.

### answered$ and finished calls

- `answered$` hands a call answered in the native UI while nobody was
  subscribed to the first subscriber, if the call is still live. On a cold
  start the buffered answer runs as soon as the SDK call fuses, which can be
  before the app's call screen subscribes.
- An `answered$` subscriber that ends the call it was handed (with
  `registry.endCall()`) is no longer undone: the registry wrote back a stale
  copy of the entry after the emission, which made the ended call live again
  and started its audio.
- The registry keeps the last 10 ended entries instead of every call the
  process ever handled, each holding its SDK call.

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
- The example's `useBridgeAnswer` subscribes once and reads `dial` and
  `onCallStarted` when it uses them. Keyed on `dial`, which changes when the
  provider creates its client, it subscribed twice on a cold start, and with
  each answer delivered once the copy that received it held the `dial` of a
  client that did not exist yet: it failed and ended the call the user had
  answered.
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

### Config plugin keeps the app's usage strings

- The iOS plugin no longer overwrites `NSMicrophoneUsageDescription` and
  `NSCameraUsageDescription`. The plugin's option wins, then a string the app
  already sets (`ios.infoPlist`, or a plugin whose mod ran first, such as
  `@config-plugins/react-native-webrtc`), then the generic default.

### Video view follows a swapped track

- `SignalWireVideoView` shows the new track after the SDK replaces one in
  place: video off then on, a camera switch, and the server-pushed-constraints
  fallback. Before, the view stayed on the stopped track (a frozen last frame
  or black self-view) for the rest of the call, because the stream object and
  its `toURL()` do not change and the native view reads the track only when
  its URL does. The view now remounts its native view on a new track, and
  draws nothing while the stream has no video track.
- A local view is mirrored by default only when its camera is not a back
  camera (`facingMode` other than `'environment'`). An explicit `mirror` prop
  still wins.
- Each view subscribes to its own stream only, rather than to all of the
  call's state through `useCall`.

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

### The relay-only ICE fallback runs on React Native

- `RTCPeerConnection.getConfiguration()`, which react-native-webrtc does not
  implement, is added to the peer connection the SDK gets. The SDK's
  relay-only ICE fallback reads it before switching to
  `iceTransportPolicy: 'relay'`; without it the fallback crashed the app (a
  TypeError from a timer, fatal in a release build) instead of restarting
  ICE through TURN. A react-native-webrtc release that has the method is
  used unchanged.

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
