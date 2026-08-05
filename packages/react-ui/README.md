# `@signalwire/react-ui`

> **Unofficial.** This is a community project, not a SignalWire product, and is
> not affiliated with or endorsed by SignalWire.

React components for the SignalWire [web components](https://www.npmjs.com/package/@signalwire/web-components).
**Browser only** — React Native has its own component kit.

These are thin wrappers, not reimplementations. The SDK already ships 26 Lit
components; this package makes the SDK-aware ones idiomatic in React.

```bash
npm install @signalwire/react-ui @signalwire/web-components @lit/react @signalwire/react
```

```tsx
import { useSignalWire } from '@signalwire/react';
import { CallControls } from '@signalwire/react-ui/call-controls';
import { CallMedia } from '@signalwire/react-ui/call-media';
import '@signalwire/react-ui/theme.css';

function CallScreen({ call }) {
  return (
    <>
      <CallMedia call={call} />
      <CallControls call={call} onCallHangup={() => console.log('ended')} />
    </>
  );
}
```

## Why wrappers at all

React 19 can set custom element properties, so the wrapper is no longer strictly
required — but it still earns its place:

- **Object props reach properties, not attributes.** `call` is a live SDK
  object. Without a wrapper React would stringify it into an attribute and the
  element would receive `"[object Object]"`.
- **Events become `on*` props.** `sw-call-hangup` arrives as `onCallHangup`
  instead of needing a ref and a manual `addEventListener`.
- **Types and tooling.** Props are typed from the element class, and editors can
  auto-import a `CallControls` symbol in a way they cannot for `<sw-call-controls>`.

## Import per component

```tsx
import { CallControls } from '@signalwire/react-ui/call-controls';  // preferred
import { CallControls } from '@signalwire/react-ui';                // pulls all 14
```

Prefer the subpath. Custom-element registration is a **side effect**, so a
bundler cannot tree-shake unused components out of the barrel — importing the
barrel registers all fourteen. For the same reason this package is deliberately
**not** marked `sideEffects: false`; doing so would let bundlers drop the
`customElements.define` call and the element would silently never upgrade.

## Components

| Import path | Element | Events |
| --- | --- | --- |
| `/call-media` | `sw-call-media` | — |
| `/self-media` | `sw-self-media` | — |
| `/local-camera` | `sw-local-camera` | — |
| `/call-status` | `sw-call-status` | — |
| `/call-provider` | `sw-call-provider` | — |
| `/call-dialpad` | `sw-call-dialpad` | — |
| `/audio-level` | `sw-audio-level` | — |
| `/click-to-call` | `sw-click-to-call` | — |
| `/call-controls` | `sw-call-controls` | `onCallHangup` |
| `/participants` | `sw-participants` | `onParticipantMuteAudio`, `onParticipantMuteVideo`, `onParticipantRemove` |
| `/participant-controls` | `sw-participant-controls` | `onParticipantPinToggle`, `onParticipantVolumeChange` |
| `/directory` | `sw-directory` | `onAddressSelect`, `onDial` |
| `/device-selector` | `sw-device-selector` | `onDeviceChange` |
| `/call-widget` | `sw-call-widget` | `onCallEnded`, `onCallHangup`, `onContentDrawerClose`, `onDial`, `onDisplayContent`, `onFullscreenToggle`, `onModalClose`, `onTranscriptToggle` |

The SDK's twelve `sw-ui-*` primitives are intentionally **not** wrapped. They
are presentational internals of the Lit library rather than API most apps reach
for, and they remain usable as plain custom elements.

## Server rendering

Every component module carries `'use client'`. Lit elements call
`customElements.define` and touch the DOM at import time, so they cannot run in
a React Server Component or during SSR. In Next.js App Router, import them from
a client component; with a classic SSR setup, render them behind a mounted check.

## Theming

```ts
import '@signalwire/react-ui/theme.css';
```

Re-exported from `@signalwire/web-components` so apps do not reach into another
package's internals. Override the CSS custom properties it defines to restyle.

## Adding a component

Wrappers are generated, not hand-written — fourteen near-identical files drift
otherwise:

1. Add an entry to `scripts/components.json`.
2. `npm run generate` — writes the wrapper, the barrel, and the `exports` map.
3. Commit the output. Consumers never run codegen.

`src/manifest.test.ts` fails if the manifest, the generated files and the
`exports` map fall out of step.

MIT
