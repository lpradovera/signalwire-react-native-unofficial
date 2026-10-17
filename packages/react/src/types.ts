import type { Call, SignalWire, SignalWireOptions } from '@signalwire/js';

/**
 * A platform layer supplied by a host package.
 *
 * On the web there is nothing to supply — the SDK uses browser globals — so
 * `SignalWireProvider` takes this as optional. `@signalwire/react-native`
 * provides one covering WebRTC, storage, and the NetInfo/AppState shims, and
 * passes the provider a function that builds one, so each client gets its
 * own and the next client never inherits a disposed one.
 */
export interface SignalWirePlatform {
  /** Merged into the `SignalWire` constructor options. */
  readonly options: SignalWireOptions;
  /** Releases anything the platform holds. Must be safe to call twice. */
  dispose(): void;
  /**
   * Calls `listener` each time the app returns to the foreground; returns a
   * function that stops it. `SignalWireProvider` uses it to renew a
   * `fetchToken` token that ran out while the app was suspended. Optional:
   * without it the provider watches the document's `visibilitychange`, which
   * is the browser's foreground signal.
   */
  watchForeground?(listener: () => void): () => void;
}

/**
 * Lets a host package observe call lifecycle without the core knowing about it.
 *
 * This is how native call UI attaches: `@signalwire/react-native` supplies an
 * observer backed by CallKit / ConnectionService. The core never imports it, so
 * a browser bundle carries none of it.
 */
export interface CallObserver {
  /**
   * Called with the client once it is constructed, and again for a new
   * observer or client. Return a function that undoes the binding: the
   * provider calls it when this observer is replaced or removed, the client
   * is replaced, or the provider unmounts. An observer passed inline is a new
   * observer on every render, so memoize it. One that returns nothing (the
   * 0.1.0 contract) can't be unbound, so it is bound once per client and a
   * later observer for the same client is not bound.
   */
  bindClient?(client: SignalWire): void | (() => void);
  /**
   * Called by `dial()` before the SDK places the call. Throw to refuse it:
   * `dial()` rejects with that error and nothing is dialled. The CallKit
   * observer throws `CallInProgressError` while another call is live.
   */
  beforeOutgoingCall?(destination: string): void;
  /** Called after a successful `dial()`, before the call is returned. */
  onOutgoingCall?(call: Call, destination: string): void;
  /**
   * Called when the app answers an inbound call from its own UI. Return `true`
   * to take over: the observer drives the answer through the native call UI so
   * the OS activates the audio session and dismisses its ringing screen.
   * Answering the SDK directly while CallKit still rings leaves iOS holding
   * the audio session — a connected call with no audio and a stuck native UI.
   * `others` says what to do with the calls already in progress (`'hold'`
   * for `answer()`, `'end'` for `endAndAnswer()`); an observer that takes
   * over does that too.
   */
  onIncomingAnswer?(call: Call, others?: OtherCalls): boolean;
  /** Same coordination for an in-app reject. Return `true` to take over. */
  onIncomingReject?(call: Call): boolean;
  /**
   * Whether the observer has turned this inbound call down (the CallKit
   * observer: refused as busy by the call-waiting policy, or declined). Such a
   * call is left out of `useIncomingCalls()`: the SDK keeps it listed, still
   * `ringing`, until its decline completes, and an in-app sheet would offer
   * it for that moment.
   */
  isIncomingRefused?(call: Call): boolean;
  /**
   * Called after the app put a call on hold or took it off (`useCalls()`'s
   * `hold`, `unhold` and `swap`, a `dial()` or `answer()` that held the
   * active call). The native call UI mirrors it, so its own screen shows the
   * same state. The hold itself has already been applied.
   */
  onHoldChange?(call: Call, held: boolean): void;
}

/**
 * What an answer does with the calls already live: put the active one on
 * hold (`'hold'`, Hold & Accept), or end them (`'end'`, End & Accept).
 */
export type OtherCalls = 'hold' | 'end';
