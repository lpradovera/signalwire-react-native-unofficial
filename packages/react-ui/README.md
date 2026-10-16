# `@signalwire/react-ui`

> **Alpha.** The browser component kit of an SDK on its way to becoming
> SignalWire's supported React and React Native SDK; APIs may change between
> alpha releases.

React components for the SignalWire [web components](https://www.npmjs.com/package/@signalwire/web-components).
**Browser only** — React Native has its own component kit.

These are thin wrappers, not reimplementations. The SDK already ships 26 Lit
components; this package makes the SDK-aware ones idiomatic in React.

```bash
npm install @signalwire/react-ui@alpha @signalwire/web-components @lit/react @signalwire/react@alpha
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

Each subpath also registers what its element renders. A
`@signalwire/web-components` subpath defines only its own tag, so
`<sw-call-controls>` on its own would render a bare, never-upgraded
`<sw-ui-control-bar>` with no buttons. `/call-controls` therefore also imports
the control bar, split button, drop-up and icon; `/call-widget` and
`/click-to-call` import everything the widget renders.

`/device-selector` loads the whole `@signalwire/web-components` package: the
upstream `sw-device-selector` subpath points at a file that no 4.0.0 RC ships,
so the selector can only be imported from the package root.

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

## ES modules only

The package ships ES modules only. `@signalwire/web-components` is an ES module
package whose subpaths define only the `import` condition, so a CommonJS build
of these wrappers could never `require()` them. Bundlers load it as is. A Node
that can `require()` ES modules (20.19+, 22.12+) loads it through `require()`
too; Jest in a CommonJS project needs these packages transformed, as for any ES
module dependency.

## Server rendering

Every component module, and the barrel, carries `'use client'`. Lit elements call
`customElements.define` and touch the DOM at import time, so they cannot run in
a React Server Component or during SSR. In Next.js App Router, import them from
a client component; with a classic SSR setup, render them behind a mounted check.

## Theming

```ts
import '@signalwire/react-ui/theme.css';
```

A copy of `@signalwire/web-components`' own `theme.css` export, from the
version this package is built and tested against (a test fails when the two
differ). An app that installs a different `@signalwire/web-components` version
can import that package's copy instead, which always matches its elements:

```ts
import '@signalwire/web-components/theme.css';
```

Override the CSS custom properties it defines to restyle.

## Adding a component

Wrappers are generated, not hand-written — fourteen near-identical files drift
otherwise:

1. Add an entry to `scripts/components.json`. `registers` lists the other
   `@signalwire/web-components` elements it renders.
2. `npm run generate` — writes the wrapper, the barrel, and the `exports` map.
3. Commit the output. Consumers never run codegen.

`src/manifest.test.ts` fails if the manifest, the generated files and the
`exports` map fall out of step. `test/entries.test.mjs` loads every built entry
point against the installed `@signalwire/web-components` and fails when an
entry cannot be imported or leaves an element it renders unregistered, which
is also what to rerun after upgrading `@signalwire/web-components`.

MIT
