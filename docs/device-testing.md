# Device-test checklist

Everything in this list requires real hardware. None of it is covered by the
192 unit tests, which mock every native module — those tests prove the logic is
right, not that the OS integration is.

Run against the example app (`example/`) with a real SignalWire subscriber
token. Record device, OS version, and result for each row.

Items 5 to 7 are the highest risk: they exercise the push path, where the OS
kills the app if the package misbehaves, and where unit tests can only simulate.

## Core calling

**1. Outbound audio call.**
Dial a known destination with `{ audio: true, video: false }`.
Expect: audio flows both ways; `useCall().status` reaches `connected`; the
native call UI shows an active call.

**2. Outbound video call.**
Dial with `{ audio: true, video: true }`.
Expect: the local self-view is mirrored, remote video renders. **Then switch
cameras mid-call** — video must keep rendering. This exercises the in-place
track replacement that `SignalWireVideoView` handles by re-reading `toURL()`
every render; a regression here shows as a frozen last frame.

**3. In-app inbound, foreground.**
Place a call to the subscriber while the app is open.
Expect: the native call UI appears; Answer connects; audio flows.

**4. Inbound while backgrounded but alive.**
Background the app, keep it running, then call the subscriber.
Expect: the native UI appears; answering from the lock screen connects and
brings the app forward.

## Push path

**5. Cold-start VoIP push.**
Force-quit the app. Send a VoIP push carrying `call_id`.
Expect: the native call UI appears within about 2 seconds; answering launches
the app and connects. If the UI does not appear, the `AppDelegate` hook in
`docs/native-setup.md` is missing or the payload lacks `call_id`.

**6. Push with no matching call.**
Send a push whose `call_id` never produces an SDK call.
Expect: the native call ends itself as a missed call within the fusion timeout
(20s by default) and leaves no stuck entry in the call log. A stuck CallKit
entry is what iOS penalises hardest — if you see one, the registry's `tick()`
is not running.

**7. Lock-screen decline before fusion.**
Decline immediately after the push arrives, before the app connects.
Expect: the intent is buffered and the call is rejected once the SDK call
arrives; no ghost call remains; the caller sees a decline, not a timeout.

## Audio and resilience

**8. Audio routing.**
Toggle speaker and earpiece mid-call. Then connect a Bluetooth headset mid-call.
Expect: output follows each change. Note that `'bluetooth'` is a request — the
OS makes the final choice, so verify by ear rather than by the reported route.

**9. Backgrounded call audio.**
Background the app mid-call.
Expect: audio continues. Failure means the `audio` background mode is missing.

**10. Network loss and recovery.**
Enable airplane mode for 10 seconds mid-call, then disable it.
Expect: the SDK notices the drop and reconnects. If nothing happens, the NetInfo
shim is not installed — check that `@react-native-community/netinfo` is present
and `platform={{ netInfo: true }}`.

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

**Still unverified: everything else requiring hardware.** No camera captured,
no CallKit UI confirmed, and no push delivered.

## Sign-off

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
