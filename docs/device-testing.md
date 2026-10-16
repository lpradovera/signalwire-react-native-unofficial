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
