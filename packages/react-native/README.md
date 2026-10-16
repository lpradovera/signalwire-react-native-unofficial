# `@signalwire/react-native`

> **Alpha.** On its way to becoming SignalWire's supported React Native SDK;
> APIs may change between alpha releases.

React Native support for [`@signalwire/js`](https://www.npmjs.com/package/@signalwire/js) v4:
platform adapters, React hooks over the SDK's RxJS observables, and native call
UI via CallKit and ConnectionService.

Published under npm's `alpha` tag: install `@alpha` (a plain install still
gets the older 1.x SDK on `latest`). To install from the repository instead,
see the
[repository README](https://github.com/lpradovera/signalwire-react-native-unofficial#install).

```bash
npm install @signalwire/react-native@alpha @signalwire/js rxjs \
  react-native-webrtc @react-native-async-storage/async-storage \
  react-native-get-random-values react-native-url-polyfill
```

```js
// index.js — MUST be the first import, before anything loads @signalwire/js
import '@signalwire/react-native/polyfills';
```

```tsx
import { SignalWireProvider, useSignalWire } from '@signalwire/react-native';

<SignalWireProvider credentialProvider={credentials} callKit>
  <App />
</SignalWireProvider>;
```

**Full documentation, including the import-order rule, the two build-config
requirements, native setup, and push:**
https://github.com/lpradovera/signalwire-react-native-unofficial

## Entry points

| Import | Contents |
| --- | --- |
| `@signalwire/react-native` | adapter, hooks, `SignalWireVideoView` |
| `@signalwire/react-native/polyfills` | required side-effect imports |
| `@signalwire/react-native/callkit` | native call UI (needs `react-native-callkeep`) |
| `@signalwire/react-native/audio` | audio routing (needs `react-native-incall-manager`) |

MIT
