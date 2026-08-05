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

## Sign-off

| # | Scenario | iOS | Android | Notes |
| --- | --- | --- | --- | --- |
| 1 | Outbound audio | | | |
| 2 | Outbound video + camera switch | | | |
| 3 | Inbound, foreground | | | |
| 4 | Inbound, backgrounded | | | |
| 5 | Cold-start VoIP push | | | |
| 6 | Push with no matching call | | | |
| 7 | Decline before fusion | | | |
| 8 | Audio routing | | | |
| 9 | Backgrounded audio | | | |
| 10 | Network loss and recovery | | | |
| 11 | Native mute and DTMF | | | |
| 12 | Concurrent calls | | | |
