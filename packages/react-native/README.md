# `@signalwire/react-native`

> **Unofficial.** This is a community project, not a SignalWire product, and is
> not affiliated with or endorsed by SignalWire.

React Native support for [`@signalwire/js`](https://www.npmjs.com/package/@signalwire/js) v4:
platform adapters, React hooks over the SDK's RxJS observables, and native call
UI via CallKit and ConnectionService.

```bash
npm install @signalwire/react-native @signalwire/js rxjs \
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

**Android on the New Architecture:** react-native-callkeep 4.3.16 crashes the
app at its first use of callkeep (`Unable to parse @ReactMethod annotations`) until callkeep
releases its upstream fix (a6573f1b). Apply
[the repository's patch](https://github.com/lpradovera/signalwire-react-native-unofficial/blob/main/patches/react-native-callkeep%2B4.3.16.patch)
with patch-package; the full README says how.

MIT
