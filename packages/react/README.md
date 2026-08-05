# `@signalwire/react`

> **Unofficial.** This is a community project, not a SignalWire product, and is
> not affiliated with or endorsed by SignalWire.

Universal React bindings for [`@signalwire/js`](https://www.npmjs.com/package/@signalwire/js) v4.

**Runs unchanged in the browser and in React Native** — this package contains no
platform-specific code. React Native users should install
[`@signalwire/react-native`](../react-native), which supplies the platform layer
and re-exports everything here.

```bash
npm install @signalwire/react @signalwire/js rxjs
```

```tsx
import { SignalWireProvider, useCall, useSignalWire } from '@signalwire/react';

function Dialer() {
  const { isConnected, dial } = useSignalWire();
  return <button disabled={!isConnected} onClick={() => void dial('/public/room')}>Call</button>;
}

// No platform prop in a browser: the SDK uses native globals.
<SignalWireProvider credentialProvider={credentials}>
  <Dialer />
</SignalWireProvider>;
```

## Hooks

| Hook | Returns |
| --- | --- |
| `useSignalWire()` | `client`, `isConnected`, `isRegistered`, `user`, `directory`, `error`, `dial`, `disconnect` |
| `useCall(call)` | `status`, `participants`, `self`, streams, mute state, `error`, and call actions |
| `useIncomingCalls()` | `calls`, `answer`, `reject` |
| `useDevices()` | `audioInputs`, `videoInputs`, selection, `refresh` |
| `useObservable(obs$, initial)` | The latest value of any SDK observable |

`useObservable` is built on `useSyncExternalStore`, so it is tear-free under
concurrent rendering, and seeds from the SDK's synchronous getters rather than
flashing a default. Every hook is safe with a null call or client.

## Platform injection

Two optional props let a host package extend the provider without this package
knowing anything about it:

```ts
interface SignalWirePlatform {
  readonly options: SignalWireOptions;   // merged into the SDK constructor
  dispose(): void;
}

interface CallObserver {
  bindClient?(client: SignalWire): void;
  onOutgoingCall?(call: Call, destination: string): void;
}
```

`@signalwire/react-native` uses the first for its WebRTC/storage/AppState layer
and the second to attach CallKit. Browser apps need neither.

This boundary is enforced by lint: an import of `react-native`, `react-native-*`
or `@react-native-*` inside this package fails the build.

## Video

There is no video component here yet — a `<video>` element and an `RTCView` have
nothing in common to abstract. The React Native package ships
`SignalWireVideoView`; for the browser, feed `call.remoteStream` into a `<video>`
element's `srcObject` (see `examples/web`), or use the Lit components in
`@signalwire/web-components`.

MIT
