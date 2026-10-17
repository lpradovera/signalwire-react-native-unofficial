# `@signalwire/react-native-ui`

> **Alpha.** On its way to becoming SignalWire's supported React Native SDK;
> APIs may change between alpha releases.

React Native call UI for the SignalWire SDK. The native counterpart to
[`@signalwire/react-ui`](../react-ui), which wraps the SDK's Lit components for
the browser — there is nothing to wrap on native, so these are built.

```bash
npm install @signalwire/react-native-ui@alpha @signalwire/react-native@alpha react-native-safe-area-context react-native-incall-manager
```

`CallControls` drives the speaker through `@signalwire/react-native/audio`,
which imports `react-native-incall-manager`, and the package's entry exports
it, so the kit does not bundle without incall-manager even if you use only
`Dialpad` or `IncomingCallSheet`. `@signalwire/react-native`'s own peers are
listed in its README.

```tsx
import type { Call } from '@signalwire/js';
import { SignalWireVideoView } from '@signalwire/react-native';
import { CallControls, CallStatus } from '@signalwire/react-native-ui';
import { StyleSheet, View } from 'react-native';

function CallScreen({ call, onEnd }: { call: Call; onEnd: () => void }) {
  return (
    <View style={{ flex: 1 }}>
      <SignalWireVideoView call={call} kind="remote" style={StyleSheet.absoluteFill} />
      <CallStatus call={call} />
      <CallControls call={call} onHangup={onEnd} />
    </View>
  );
}
```

## Components

| Component | Purpose |
| --- | --- |
| `CallControls` | Mute, camera, speaker toggle, iOS audio output button and hang up |
| `CallStatus` | Status pill, showing a fatal call error when there is one |
| `Dialpad` | DTMF keypad; works with or without a call |
| `ParticipantList` | The other participants, with live talking and mute state |
| `DeviceSelector` | Microphone or camera picker |
| `IncomingCallSheet` | In-app inbound call sheet |
| `CallOverlayHost` | Optional root overlay the incoming sheet draws in |
| `ControlButton` | The shared pressable, for building your own bar |

## The incoming-call sheet and `CallOverlayHost`

Mount a `CallOverlayHost` once, as the last child of your root view, and
`IncomingCallSheet` draws in it, over the app:

```tsx
<View style={{ flex: 1 }}>
  <App />
  <CallOverlayHost />
</View>
```

Without a host the sheet falls back to a `Modal`. A Modal is a separate native
window: on iOS it cannot appear while your app has a Modal of its own up, and
on Android 15 and later it is drawn edge to edge, under the navigation bar.
The host has neither problem. To show the sheet over one of your own Modals,
mount another `CallOverlayHost` inside that Modal; the most recently mounted
host is used, and the sheet moves back when it closes.

Either way the sheet pads itself by the bottom safe-area inset, with its own
`SafeAreaProvider` (the app's does not reach into a Modal's window).
`react-native-safe-area-context` (4 or later) is a peer dependency.

## They hold no state

Every component reads from the hooks in `@signalwire/react` and writes through
the SDK. Nothing keeps a local copy of "am I muted".

That matters more on mobile than it sounds: mute can change from the CallKit
lock-screen button, from ConnectionService, or from the server. A component
holding local state would drift out of sync the first time that happened, and
there is a test pinning this exact case.

## Theming

Optional — every component falls back to the built-in dark theme, so you can
drop a single control bar in without wrapping anything.

```tsx
import { SignalWireThemeProvider } from '@signalwire/react-native-ui';

<SignalWireThemeProvider theme={{ colors: { accent: '#7c3aed' } }}>
  <App />
</SignalWireThemeProvider>;
```

Overrides merge one level deep onto `defaultTheme`, so a single colour can be
changed without restating the rest. Tokens cover colours, spacing, radii and
type sizes; anything richer belongs in your app.

## Why text labels rather than icons

Buttons are labelled `Mute`, `Camera off`, `End`. An icon set would mean either
a dependency (`react-native-svg`) or bundled glyphs, and text labels are legible
to screen readers without extra `accessibilityLabel` plumbing.

Every control carries an `accessibilityRole`, a label and — where it toggles —
`accessibilityState`. A toggle keeps one accessible name (`Mute`, `Camera off`,
`Speaker`) and reports its state as selected, while its visible text says what a
tap does (`Unmute`) or, for the speaker, which route the call is on.

`ControlButton` draws text only: it has no icon or children slot. If you want
icons, build your own button and drive it with the hooks directly (`useCall`
for mute, camera and hang up, `useAudioRoute` from
`@signalwire/react-native/audio` for the speaker); that path is deliberately
open.

## What is absent, and why

- **No audio level meter.** The SDK measures levels with `AudioContext`, which
  React Native does not have. `ParticipantList` shows talking state from the
  SDK's `isTalking$` instead, which is server-driven and works.
- **No audio *output* picker in `DeviceSelector`.** React Native has no
  `setSinkId`. Routing between earpiece, speaker, headset and Bluetooth is
  `useAudioRoute`, whose speaker toggle `CallControls` shows. On iOS
  `CallControls` also shows the system audio output button
  (`AudioRoutePickerButton` from `@signalwire/react-native/audio`, iOS's own
  menu of the phone, the speaker and each headset or car); `showRoutePicker`
  (default: `showAudioRoute`) hides it. It needs react-native-incall-manager
  with iOS audio routes (the upstream change, or the patch in the
  repository's [`docs/patches/`](https://github.com/lpradovera/signalwire-react-native-unofficial/tree/main/docs/patches),
  which isn't in the npm package; how to apply it is in the repository
  README's "Audio routes on iOS"); on released incall-manager
  4.3.0 it isn't shown and the controls offer speaker on/off. It is native
  code: it appears only once the app has been rebuilt (`pod install`, or
  `expo prebuild`) with this version of `@signalwire/react-native`.
- **No video component.** `SignalWireVideoView` already ships in
  `@signalwire/react-native`.

MIT
