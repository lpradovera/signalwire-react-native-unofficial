# Device-test checklist

Everything in this list requires real hardware. None of it is covered by the
unit tests, which mock every native module — those tests prove the logic is
right, not that the OS integration is.

Run against the example app (`example/`) with a real SignalWire subscriber
token. Record device, OS version, and result for each row.

Items 5 to 7 are the highest risk: they exercise the push path, where the OS
kills the app if the package misbehaves, and where unit tests can only simulate.

## Bringing the environment up

```bash
scripts/dev.sh up       # start everything, then prove each link
scripts/dev.sh status   # what is running
scripts/dev.sh down     # stop everything, funnel first
```

Four services must be alive at once, and when any one is down the symptom on
the device is identical every time — the call simply never arrives:

| | | Down means |
| --- | --- | --- |
| support server | `:3000` | no tokens, no pushes, no parked callers |
| Tailscale funnel | `:443` | SignalWire cannot fetch the park SWML, so a call dies before any push is sent |
| Metro | `:8081` | the dev-client build shows "No development server found"; no JavaScript runs, so nothing can answer |
| Vite web example | `:5173` | no second subscriber to call from |

`up` verifies rather than reports: it checks the server from the public
internet (the only view SignalWire has), asks Metro to actually *build* the
bundle rather than merely answer on its port, and counts registered push
devices. Each of those is a link that has silently broken here and cost a
debugging session.

**The iPad does not need a cable.** It reaches the Mac over the tailnet, which
is why `example/.env` points at a `*.ts.net` hostname and why the script pins
`REACT_NATIVE_PACKAGER_HOSTNAME` to the same name — a physical device is not on
the Mac's loopback and may not share its WiFi. A cable is only for reinstalling
the app or streaming the device console.

**Turn the funnel off when you stop.** It publishes port 3000, the whole
server, to the public internet. With the development settings in
`server/.env`, `ALLOW_UNAUTHENTICATED_TOKENS=1` mints a subscriber token for anyone who asks,
and with `API_TOKEN` unset (the example app registers without it) `/notify`,
`/devices` and `/webhooks/signalwire` are open too: anyone can push a call to
any user, list every device token, and register or delete devices.
`scripts/dev.sh down` disables the funnel first, before anything else.

Two failure modes worth recognising rather than re-debugging:

- **Two `tsx --watch` supervisors.** Starting the server twice leaves both
  watching; every file save restarts both, they race for port 3000, and the
  loser exiting mid-push cancels the in-flight APNs stream. That reads exactly
  like a broken push (`The pending stream has been canceled`). `dev.sh` leaves
  a running service alone and never starts a second.
- **Docker holding `:8081`.** Docker Desktop binds Metro's port. Metro then
  never binds, and the app keeps showing "No development server found" no
  matter how many times you restart it.

## Core calling

**1. Outbound audio call.**
Dial a known destination with `{ audio: true, video: false }`.
Expect: audio flows both ways; `useCall().status` reaches `connected`; the
native call UI shows an active call.

**2. Outbound video call.**
Dial with `{ audio: true, video: true }`.
Expect: the local self-view is mirrored, remote video renders. **Then turn
video off and on, and switch to the back camera and back, mid-call** — the
self-view must go blank while video is off and show live video after each
change, mirrored on the front camera and not on the back. The SDK swaps the
track inside the same `MediaStream` (same `toURL()`) in all of these, and
`SignalWireVideoView` remounts its native view on the new track; a regression
here shows as a frozen last frame or a black self-view while the far end sees
video.

**3. In-app inbound, foreground.**
Place a call to the subscriber while the app is open.
Expect: the native call UI appears; Answer connects; audio flows.

**4. Inbound while backgrounded but alive.**
Background the app, keep it running, then call the subscriber.
Expect: on Android the incoming-call notification rings with Answer and
Decline (heads-up when unlocked; over the lock screen, the app opens on top of
it); answering connects. On iOS the CallKit screen appears and answering from
the lock screen connects.

**5. Call waiting (`callWaiting: 'full'`, the default).**
During a call, place a second call to the subscriber.
Expect: it rings over the call (iOS: CallKit's waiting-call screen with Hold &
Accept, End & Accept, Decline; Android: the in-app sheet with the same three,
or the notification in the background). Hold & Accept connects the second call
and holds the first: with the example's `EXPO_PUBLIC_SW_DEV_STATS=1`, the held
call's `in` and `out` counters stop and its sender shows `paused`. Swap
resumes the first and holds the second. Ending either leaves the other
running. End & Accept ends the first. Dialling during a call holds the live
call. A third call is refused as busy. With `'endAndAccept'` only End &
Accept and Decline are offered and dialling throws `CallInProgressError`;
with `'single'` the second call is busy and never rings.

Run on the Android emulator (API 35, 2026-10-16), each mode its own build
(the launch log reads `CallKit ready (callWaiting: <mode>, …)`):

- `'full'`: Decline of a second call while the first is live. The caller's
  leg ended 8 s after it was placed (`[WebRTCManager] Inbound call rejected by
  user.`); the first call carried on, its RTP counters rising, with no hold.
- `'endAndAccept'`: the sheet offered only Decline and End & Accept. Dial
  again showed `CallInProgressError: A call is already in progress (<uuid>)`
  and placed nothing. Decline ended the second call and left the first
  running; End & Accept on a third ended the first and connected the third.
- `'single'`: Dial again threw `CallInProgressError`; a second inbound call
  never showed (no sheet) and its leg ended in 0.7 s (`Refusing inbound call
  <id> as busy: <uuid> is live; not showing it`); Telecom listed one call,
  ACTIVE.

**6. Back during a call (Android).**
Press Back on the root screen during a call.
Expect: the call goes on (audio, the ongoing-call notification); tapping the
notification brings the call screen back. With `endCallsOnHostDestroy: true`,
Back ends the call instead.

**7. Lock screen without the native call UI (Android 14+).**
With `callKit` off (the example's `EXPO_PUBLIC_SW_CALLKIT=0`), place a call,
then lock the phone for 20 s and talk.
Expect: the far end hears you the whole time. During the call `adb shell
dumpsys activity services <package>` lists
`com.signalwire.reactnative.CallForegroundService` with `isForeground=true`
and `types=0x00000080` (microphone), the "Call in progress" notification shows,
and both go when the call ends. `adb shell dumpsys audio` shows the app's
`VOICE_COMMUNICATION` recording with `silenced:false` while locked.
On the emulator (2026-10-16): with the service, `silenced:false` in all 7
samples over 15 s locked, and the server counted as many packets from the app
as to it (1386 / 1390). With the service disabled, the recording went
`silenced:true` about 6 s after the lock, in 5 of 7 samples, and the server got
918 packets from the app against 1364 to it.

**Process death.** If the process dies mid-call (the system kills it, or the
user force-stops it), nothing on the device sends a bye. The call's leg on
SignalWire is left up until the server notices: on the iPhone (2026-10-16) a
killed app's call stayed `answered`, with its uplink stopped, until it was
ended by REST 10 s later; the server's own timeout was not reached. On the
Android emulator (2026-10-16, `adb shell am force-stop` 25 s into an outbound
call to `/private/rn-device-test`, then the call's status read by REST every 2 s):
the leg stayed `answered` for the 29 s watched (the test's 60 s call cap), and
was ended by REST. The server received 1195 packets from the app in all (the
app had sent 1136 a second before the kill) while it sent 2659: it kept
sending to a device that was gone. Treat it as a server-side limit; a backend that must bound such
a leg can end it by REST from its own watchdog.

## Push path

**5. Cold-start VoIP push.**
Force-quit the app. Send a VoIP push carrying `call_id`.
Expect: the native call UI appears within about 2 seconds; answering launches
the app and connects. The generated hook reports every VoIP push to CallKit,
with or without `call_id`, so if the UI does not appear the hook is not in the
build (`SignalWireVoipPush.m` not generated or not compiled — run
`npm run verify:prebuild`), the build lacks `aps-environment`, or the push never
reached the device (check the `[SignalWireVoipPush]` lines in the device
console). A missing `call_id` shows later, as a call that rings but never
fuses.

**6. Push with no matching call.**
Send a push whose `call_id` never produces an SDK call.
Expect: the native call ends itself as a missed call at the fusion timeout
(45 s by default, plus up to one 2 s tick) and leaves no stuck entry in the call
log. A stuck CallKit
entry is what iOS penalises hardest — if you see one, the registry's `tick()`
is not running.

**7. Lock-screen decline before fusion.**
Decline immediately after the push arrives, before the app connects.
Expect: the intent is buffered and the call is rejected once the SDK call
arrives; no ghost call remains; the caller sees a decline, not a timeout.

## Audio and resilience

**8. Audio routing.**
Toggle speaker and earpiece mid-call. Plug in wired or USB-C headphones
mid-call (the label should read "Headset"). Then connect a Bluetooth headset mid-call,
pick a route in the system route menu, and tap CallKit's speaker button.
Expect: output follows each change, and with incall-manager's iOS routes
`route` (the speaker button's label) names where the audio actually is: check
both by ear and against the label. With released incall-manager on iOS,
`'bluetooth'` is ignored with a warning and `route` is what was asked for.
Also: tap the speaker while an outbound call is still ringing (it should apply
when the call connects), and start a video call with AirPods connected (it
should stay on the AirPods). Tap the speaker while an outbound call rings and
cancel the call: the next call must not start on the speaker. On Android,
start a video call with a Bluetooth headset connected: the label should read
"Bluetooth" (from incall-manager's device report), and speaker on then off
should come back to the headset, not the earpiece (the Android behaviour is
derived from incall-manager's Java, not yet seen on a device).

**9. Backgrounded call audio.**
Background the app mid-call.
Expect: audio continues. Failure means the `audio` background mode is missing.

**10. Network loss and recovery.**
Enable airplane mode for 10 seconds mid-call, then disable it.
Expect: the SDK notices the drop and reconnects. If nothing happens, the NetInfo
shim did not start — look for `Network monitoring unavailable` in the log (it
carries the reason) and check the provider is not given
`platform={{ netInfo: false }}`.

**11. Mute and DTMF from the native UI.**
Use the CallKit keypad and the mute button rather than the in-app controls.
Expect: both reach the SDK — the remote side hears the mute, and DTMF digits
register.

**12. Concurrent calls.**
Receive a second inbound call while one is active.
Expect: each native entry maps to the correct SDK call; answering the second
does not act on the first. If the push payloads lack `call_id`, this is the
scenario that will fail first.

## What the iOS Simulator established (2026-08-06)

The Simulator cannot sign off any row below — it has no CallKit, and
`Devices enumerated: {audioInputs: 0, audioOutputs: 0, videoInputs: 0}`, so no
call carries real media. It did clear the whole path up to media, on
macOS 26.3.1 / Xcode 26.6 / Expo SDK 54 / RN 0.81.5 / legacy architecture:

- App builds, launches and boots to the token screen. Per TESTING.md that alone
  clears all three import-time breakages on a real Hermes runtime.
- `react-native-webrtc` 124.0.8 and `react-native-callkeep` 4.3.16 compile and
  link, despite neither having a release targeting RN 0.81.
- Subscriber token fetched from the support server, WebSocket authenticated,
  `subscriber.online` returned 200, transport pings answered.
- Outbound `dial()` produced an offer, gathered ICE including `typ relay`
  candidates, and the `webrtc.verto` invite was accepted with code 200.

It also found three bugs the 232 unit tests could not, all now fixed with
regression tests: `bindClient` read `client.session` before the client had
connected and crashed on launch; `useObservable` discarded every emission from
the SDK's deferred, fresh-identity observables, so `isConnected` stayed false
for the life of a connected client; and the hangup button only navigated away
if teardown resolved, stranding the user when a call went unanswered.

### Inbound took five layered fixes — the order matters

Item 3 failed five times, each failure hiding the next. Recorded because the
symptom was identical every time (call connects, no audio) while the cause
moved:

1. **The answer offered video.** `IncomingCallSheet` and the native answer path
   both defaulted to `{audio, video}`. An SDP answer cannot introduce an m-line
   the offer lacks, so answering an audio-only call failed outright.
2. **`RTCRtpSender.setStreams` does not exist in react-native-webrtc.** The
   SDK's inbound path calls it on the transceivers `setRemoteDescription`
   created. Outbound never touches it, which is why only inbound broke.
3. **The in-app answer bypassed CallKit.** Answering the SDK directly leaves
   iOS holding the audio session for a call it still thinks is ringing:
   connected, silent, and the native UI keeps ringing.
4. **Two CallKit bridges existed.** tsup builds each subpath entry
   self-contained, so `CallKeepBridge` was duplicated into `dist/index.*` and
   `dist/callkit.*`. `setup()` ran on one copy, the registry lived on the
   other. The tell was `uuid=<valid>, setup=false` — impossible on one object.
   Both singletons now live on `globalThis`.
5. **A native answer never reached React.** CallKit Accept connected the call
   with audio while `activeCall` stayed null, so the app looked frozen and only
   the in-app button appeared to work. The registry now emits `answered$`.

Only 1 and 2 are diagnosable from a log alone. 3–5 needed someone watching the
device while reading the log, which is the argument for this whole document.

### Do not offer video to an audio-only destination

Item 1 failed for hours against `/private/hello-world` with the far end
accepting the invite (verto **200**) and never answering, then timing out with
no media. The cause was the dial options, not the transport:

```js
dial(target, { audio: true, video: true })   // offers a sendonly video m-line
```

An audio-only destination never answers that offer. `setRemoteDescription` is
never called, so no media can flow, and the failure looks like a network
problem — ICE completes, TURN relay candidates are present, the offer is
well-formed. Dropping to `{ audio: true, video: false }` connected on the first
attempt, with audio both ways.

This reproduced identically in `examples/web/`, which is what exonerated the
React Native layer: same SDK, same core, browser WebRTC, same silence. If a
call reaches "invite successful" and then nothing, check the m-lines offered
before suspecting the network.

**What the Simulator left unverified** was everything requiring hardware: no
camera captured, no CallKit UI confirmed, and no push delivered. The iPad
session later the same day signed off rows 1, 3, 5 and 6 below; the remaining
rows are still open.

## The Android emulator suite (automated)

`example/device-tests/` drives the example on an Android emulator with UI
Automator and checks every call's audio, so the Android rows above can be
re-run without a person. It does not replace the phone: the emulator has no
earpiece, no Bluetooth, no real FCM and a stock lock screen (see "Not covered"
below).

**How it works.** `android/` is a self-instrumenting test APK
(`com.signalwire.devicetests`, androidx UI Automator 2.3). The tests drive
the example from outside its process: React Native's `testID` is the view's
resource-id (`By.res("sw-hangup")`), system UI (the heads-up, the shade, the
lock screen) is found by text or content description, and nothing is tapped
by coordinates. They lock the screen, toggle the network and force-stop the
app through the shell. `host/hostd.py` runs on the Mac (the emulator reaches
it as `10.0.2.2`): it proxies the app's `/token` to the example server (and
can answer 401), places inbound calls by REST, reads each leg's packet
counts, runs emulator console commands (the proximity sensor), and ends any
test call older than 55 s, polling every 2 s. `suite.sh` builds the example
in each configuration (full, `endAndAccept`, `single`, end-on-Back,
`EXPO_PUBLIC_SW_CALLKIT=0`, and a push build with a simulated FCM receiver),
clearing Metro's cache before each, runs the groups and sweeps the calls.

**Audio evidence.** The builds set `EXPO_PUBLIC_SW_DEV_STATS=1`. After every
switch (answer, Hold & Accept, each Swap, End of the other call, End &
Accept, resume, unlock, return from the notification) a test reads two
`[DEVSTATS]` samples and requires at least 20 packets/s each way on the live
call and none, with its sender `audio:paused`, on a held one. React Native
pauses JS timers while the app is in the background or the screen is off,
so across those windows the cumulative counters before and after give the
rate. Each run directory has `legs.txt`: the samples between the test's
markers, and each REST leg's packets from and to the app.

**Running it.** Boot an API 35 emulator, copy
`example/device-tests/suite.env.example` to `suite.env` and fill it in
(credentials stay in the server's env file, which nothing prints), then:

```bash
npm ci
example/device-tests/suite.sh                 # every group, about 23 calls
example/device-tests/suite.sh calls cw        # some groups
```

Groups: `launch`, `calls`, `cw`, `back`, `connection`, `endonback`, `modes`,
`nocallkit`, `push` (call counts in `suite.sh`). Output goes to
`example/device-tests/.out/` (`runs/<test>-<build>-<time>/` with
`logcat.txt`, `legs.txt`, screenshots and window dumps; `calls.txt` with
every call and the minutes). On a Mac where adb's mDNS code crashes, export
`ADB_MDNS=0` (the script does).

**What it found (2026-10-17, API 35, react-native-webrtc 155).** Two defects,
both fixed in the package's Android code:

- Answering an inbound call could leave the caller ringing: libwebrtc's
  Android network monitor restarts with the answer's ICE gathering session
  and, until the platform's callbacks arrive, reports no network, so no
  candidate was gathered and the SDK never sent its answer (2 of 4 answers
  before, 5 of 5 after). The package now sets the
  `WebRTC-AndroidNetworkMonitor-IsAdapterAvailable/Disabled/` field trial.
- A pushed call's Answer did nothing with the app killed: the Answer intent
  arrived as a new intent before React had an activity and was dropped.

And one platform limit: about 5 s after the app goes to the background,
Android cuts its sockets ("Destroyed live tcp sockets for uids=…"), so with
push off a call placed minutes later never reaches the device. Calls to a
backgrounded app need push; the `push` group covers that path.

One observation was not the app: once, after returning from the
ongoing-call notification, the app received 21 and 72 packets in two 2 s
windows while SignalWire sent 50/s. Its own send counter kept pace, yet
SignalWire got about 100 packets (2 s) fewer than the app sent, where
other legs match the app's counters within a few packets: about 2 s of
loss both ways below the app (the emulator's network or the Mac's), not
its receive path. The same scenario run three more times kept 50/s each
way across the return, with at most 3 packets lost. `[DEVSTATS]` now logs
`lost` (inbound packetsLost) and `legs.txt` shows it, so a gap with
`lost` growing is packets that never arrived, and one without is the app.

**Not covered** (the emulator can't): the earpiece route and proximity
screen-off on it (the emulator offers only the speaker; the sensor reaches
incall-manager, which correctly keeps the screen on for the speaker),
Bluetooth, a real FCM delivery (the simulated receiver plus the temporary
allowlist Google Play services grants stand in for it), and OEM lock
screens.

## Sign-off

The Android column is empty: Android has been exercised on an emulator during
development (see the README's "What is verified"), but no Android scenario has
been run against this checklist and signed off yet.

| # | Scenario | iOS | Android | Notes |
| --- | --- | --- | --- | --- |
| 1 | Outbound audio | ✅ 2026-08-06 | | iPad Air 5, iPadOS 17.5.1, Expo SDK 54 / RN 0.81.5, legacy arch. Audio confirmed by ear. **Dial audio-only.** See below. |
| 2 | Outbound video + camera switch | | | |
| 3 | Inbound, foreground | ✅ 2026-08-06 | | iPad Air 5, iPadOS 17.5.1. Called from `examples/web` as a second subscriber. CallKit UI appeared, **Accept works**, audio both ways. In-app sheet answer also works. |
| 4 | Inbound, backgrounded | | | |
| 5 | Cold-start VoIP push | ✅ 2026-08-06 | | App killed via devicectl (pid gone, no JS). Push delivered; iOS relaunched the app and the native hook reported to CallKit before JavaScript existed. APNs token auth with a .p8 key. |
| 6 | Push with no matching call | ✅ 2026-08-06 | | Every push in this session carried a `call_id` no SDK call ever matched; each ended itself as missed at the fusion timeout with no stuck entry. |
| 7 | Decline before fusion | | | |
| 8 | Audio routing | | | |
| 9 | Backgrounded audio | | | |
| 10 | Network loss and recovery | | | |
| 11 | Native mute and DTMF | | | |
| 12 | Concurrent calls | | | |
