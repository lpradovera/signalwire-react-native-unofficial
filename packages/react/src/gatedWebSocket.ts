import type { WebSocketAdapter } from '@signalwire/js';

type Listener = (event: unknown) => void;

/** The part of a WebSocket the SDK's transport uses. */
interface SocketLike {
  readonly readyState: number;
  addEventListener(type: string, listener: Listener): void;
  removeEventListener(type: string, listener: Listener): void;
  send(data: unknown): void;
  close(code?: number, reason?: string): void;
}

type SocketConstructor = new (...args: never[]) => SocketLike;

const CONNECTING = 0;
const CLOSED = 3;
const EVENTS = ['open', 'message', 'error', 'close'] as const;

/**
 * A WebSocket constructor whose sockets open only once `gate()` settles.
 *
 * The SDK's transport makes a socket and waits for its `open`, then
 * authenticates with the token it holds. Handing it this constructor lets the
 * provider hold a reconnect until that token is a fresh one (see
 * `TokenSource.whenTokenFresh`). Until the gate settles the socket is
 * CONNECTING: listeners are kept and attached to the real socket when it is
 * made, `send()` throws as a CONNECTING WebSocket's does, and `close()` drops
 * it without ever opening it, with a `close` event as a real socket gives. A
 * gate that rejects opens the socket anyway.
 *
 * Only `addEventListener` is forwarded, not the `on…` properties: the SDK's
 * transport uses listeners.
 */
export function gateWebSocket(Base: SocketConstructor, gate: () => Promise<void>): WebSocketAdapter {
  class GatedWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    private socket: SocketLike | null = null;
    private closedEarly = false;
    private readonly listeners = new Map<string, Set<Listener>>();

    constructor(...args: never[]) {
      void gate()
        .catch(() => undefined)
        .then(() => this.open(args));
    }

    get readyState(): number {
      if (this.socket) {
        return this.socket.readyState;
      }
      return this.closedEarly ? CLOSED : CONNECTING;
    }

    addEventListener(type: string, listener: Listener): void {
      let set = this.listeners.get(type);
      if (!set) {
        set = new Set();
        this.listeners.set(type, set);
      }
      set.add(listener);
    }

    removeEventListener(type: string, listener: Listener): void {
      this.listeners.get(type)?.delete(listener);
    }

    send(data: unknown): void {
      if (!this.socket) {
        throw new Error('WebSocket is not open');
      }
      this.socket.send(data);
    }

    close(code?: number, reason?: string): void {
      if (this.socket) {
        this.socket.close(code, reason);
        return;
      }
      if (this.closedEarly) {
        return;
      }
      this.closedEarly = true;
      setTimeout(() => {
        this.dispatch('close', { type: 'close', code: code ?? 1000, reason: reason ?? '', wasClean: true });
      }, 0);
    }

    private open(args: never[]): void {
      if (this.closedEarly) {
        return;
      }
      let socket: SocketLike;
      try {
        socket = new Base(...args);
      } catch (error) {
        this.closedEarly = true;
        this.dispatch('error', { type: 'error', error });
        this.dispatch('close', { type: 'close', code: 1006, reason: String(error), wasClean: false });
        return;
      }
      this.socket = socket;
      for (const type of EVENTS) {
        socket.addEventListener(type, (event) => this.dispatch(type, event));
      }
    }

    private dispatch(type: string, event: unknown): void {
      for (const listener of [...(this.listeners.get(type) ?? [])]) {
        listener(event);
      }
    }
  }
  return GatedWebSocket as unknown as WebSocketAdapter;
}
