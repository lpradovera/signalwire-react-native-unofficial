/**
 * The REAL @signalwire/js, talking to an in-process fake server.
 *
 * The package's default double (signalwire-js.mock.ts) and the hand-rolled
 * fakes in the unit tests are friendlier than the SDK: their destroy() never
 * throws, their session exists from the first render, their observables emit
 * synchronously. The bugs live exactly in those differences, so the tests
 * for client and session lifecycles run against the real client instead:
 *
 *   jest.mock('@signalwire/js', () => jest.requireActual('../jest/realSdk').sdk);
 *
 * FakeServerSocket stands in for the relay: it opens, answers
 * signalwire.connect with a valid result and every other request with an
 * empty success, and records what the client sent. installFakeFetch() serves
 * the subscriber profile the client fetches before it connects.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The real package's CommonJS build, found the way Node would find the
 * package (its `exports` map has no ./package.json to resolve, and
 * '@signalwire/js' itself is mapped to the double).
 */
function sdkEntry(): string {
  for (let dir = __dirname; dir !== dirname(dir); dir = dirname(dir)) {
    const entry = join(dir, 'node_modules', '@signalwire', 'js', 'dist', 'index.cjs');
    if (existsSync(entry)) return entry;
  }
  throw new Error('@signalwire/js is not installed');
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
export const sdk = jest.requireActual(sdkEntry()) as typeof import('@signalwire/js');

type Listener = (event: unknown) => void;

export const server = {
  sockets: [] as FakeServerSocket[],
  /** `method` or `method:params.method` of every request the client sent. */
  sent: [] as string[],
  reset(): void {
    for (const socket of this.sockets) socket.closed = true;
    this.sockets = [];
    this.sent = [];
  },
  count(method: string): number {
    return this.sent.filter((m) => m === method).length;
  },
  open(): FakeServerSocket[] {
    return this.sockets.filter((s) => !s.closed);
  }
};

export class FakeServerSocket {
  public readyState = 0;
  public closed = false;
  private listeners: Record<string, Listener[]> = {};

  constructor(public url: string) {
    server.sockets.push(this);
    setTimeout(() => {
      if (!this.closed) {
        this.readyState = 1;
        this.fire('open', {});
      }
    }, 0);
  }

  addEventListener(type: string, fn: Listener): void {
    (this.listeners[type] ??= []).push(fn);
  }

  removeEventListener(type: string, fn: Listener): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn);
  }

  fire(type: string, event: unknown): void {
    for (const fn of [...(this.listeners[type] ?? [])]) fn(event);
  }

  send(data: string): void {
    const message = JSON.parse(data) as {
      id?: string;
      method?: string;
      params?: { method?: string };
    };
    server.sent.push(
      message.params?.method ? `${message.method}:${message.params.method}` : String(message.method)
    );
    if (!message.id || !message.method) return;
    const result =
      message.method === 'signalwire.connect'
        ? {
            identity: 'identity-1',
            protocol: 'protocol-1',
            authorization: { jti: 'jti-1', project_id: 'project-1', fabric_subscriber: {} },
            ice_servers: []
          }
        : {};
    setTimeout(() => {
      if (!this.closed) {
        this.fire('message', { data: JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) });
      }
    }, 0);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    setTimeout(() => this.fire('close', { code: 1000 }), 0);
  }

  /** The network drops the socket. */
  drop(): void {
    this.closed = true;
    this.readyState = 3;
    this.fire('close', { code: 1006 });
  }
}

const base64url = (value: unknown): string =>
  Buffer.from(JSON.stringify(value))
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

/** A subscriber token the SDK accepts (it decodes only the header's `ch`). */
export const token = `${base64url({ alg: 'none', typ: 'SAT', ch: 'relay.example.com' })}.${base64url({ sub: 'subscriber' })}.signature`;

/** Client options that keep the real client off the network and the hardware. */
export const options = {
  webSocketConstructor: FakeServerSocket as never,
  webRTCApiProvider: {
    RTCPeerConnection: class {},
    mediaDevices: {
      getUserMedia: async () => ({}),
      enumerateDevices: async () => [],
      addEventListener: () => undefined,
      removeEventListener: () => undefined
    }
  } as never,
  skipDeviceMonitoring: true
};

/** Serves the subscriber profile the client fetches before it connects. */
export function installFakeFetch(): void {
  (globalThis as { fetch?: unknown }).fetch = jest.fn(async (url: string) => {
    const body = JSON.stringify({
      id: 'subscriber-1',
      email: 'subscriber@example.com',
      display_name: 'Subscriber',
      fabric_addresses: []
    });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      url: String(url),
      headers: { forEach: () => undefined, entries: () => [][Symbol.iterator]() },
      text: async () => body,
      json: async () => JSON.parse(body)
    };
  });
}

/** Silences the SDK's own logging; returns the warn spy. */
export function quietSdk(): jest.Mock {
  const warn = jest.fn();
  const quiet = (): void => undefined;
  sdk.setLogger({ warn, error: quiet, info: quiet, debug: quiet, trace: quiet } as never);
  return warn;
}

export const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
