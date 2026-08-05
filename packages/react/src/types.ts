import type { Call, SignalWire, SignalWireOptions } from '@signalwire/js';

/**
 * A platform layer supplied by a host package.
 *
 * On the web there is nothing to supply — the SDK uses browser globals — so
 * `SignalWireProvider` takes this as optional. `@signalwire/react-native`
 * provides one covering WebRTC, storage, and the NetInfo/AppState shims.
 */
export interface SignalWirePlatform {
  /** Merged into the `SignalWire` constructor options. */
  readonly options: SignalWireOptions;
  /** Releases anything the platform holds. Must be safe to call twice. */
  dispose(): void;
}

/**
 * Lets a host package observe call lifecycle without the core knowing about it.
 *
 * This is how native call UI attaches: `@signalwire/react-native` supplies an
 * observer backed by CallKit / ConnectionService. The core never imports it, so
 * a browser bundle carries none of it.
 */
export interface CallObserver {
  /** Called once, immediately after the client is constructed. */
  bindClient?(client: SignalWire): void;
  /** Called after a successful `dial()`, before the call is returned. */
  onOutgoingCall?(call: Call, destination: string): void;
}
