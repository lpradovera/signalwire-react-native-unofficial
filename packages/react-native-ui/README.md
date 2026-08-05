# `@signalwire/react-native-ui`

> **Unofficial.** This is a community project, not a SignalWire product, and is
> not affiliated with or endorsed by SignalWire.

React Native call UI for the SignalWire SDK. The native counterpart to
[`@signalwire/react-ui`](../react-ui), which wraps the SDK's Lit components for
the browser — there is nothing to wrap on native, so these are built.

```bash
npm install @signalwire/react-native-ui @signalwire/react-native
```

```tsx
import { SignalWireVideoView } from '@signalwire/react-native';
import { CallControls, CallStatus, IncomingCallSheet } from '@signalwire/react-native-ui';

function CallScreen({ call }) {
  return (
    <View style={{ flex: 1 }}>
      <SignalWireVideoView call={call} kind="remote" style={StyleSheet.absoluteFill} />
      <CallStatus call={call} />
      <CallControls call={call} onHangup={goBack} />
    </View>
  );
}
```

## Components

| Component | Purpose |
| --- | --- |
| `CallControls` | Mute, camera, audio route and hang up |
| `CallStatus` | Status pill, showing call errors when present |
| `Dialpad` | DTMF keypad; works with or without a call |
| `ParticipantList` | Participants with live talking and mute state |
| `DeviceSelector` | Microphone or camera picker |
| `IncomingCallSheet` | In-app inbound call sheet |
| `ControlButton` | The shared pressable, for building your own bar |

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
`accessibilityState`. If you want icons, compose your own bar out of
`ControlButton` or the hooks directly; that path is deliberately open.

## What is absent, and why

- **No audio level meter.** The SDK measures levels with `AudioContext`, which
  React Native does not have. `ParticipantList` shows talking state from the
  SDK's `isTalking$` instead, which is server-driven and works.
- **No audio *output* picker in `DeviceSelector`.** React Native has no
  `setSinkId`. Routing between earpiece, speaker and Bluetooth is
  `useAudioRoute`, which `CallControls` exposes.
- **No video component.** `SignalWireVideoView` already ships in
  `@signalwire/react-native`.

MIT
