import { gateWebSocket } from './gatedWebSocket';

type Listener = (event: unknown) => void;

/** A stand-in for the platform WebSocket: records itself and lets the test fire events. */
class FakeSocket {
  static created: FakeSocket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  closed: Array<[number | undefined, string | undefined]> = [];
  private listeners = new Map<string, Set<Listener>>();

  constructor(
    readonly url: string,
    readonly protocols?: string | string[]
  ) {
    FakeSocket.created.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed.push([code, reason]);
  }

  fire(type: string, event: unknown = { type }): void {
    if (type === 'open') this.readyState = 1;
    if (type === 'close') this.readyState = 3;
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  FakeSocket.created = [];
});

describe('gateWebSocket', () => {
  it('opens the real socket only once the gate lets it, with the same arguments', async () => {
    const gate = deferred();
    const Gated = gateWebSocket(FakeSocket as never, () => gate.promise);
    const socket = new Gated('wss://relay.example/api', ['verto']);
    await flush();
    expect(FakeSocket.created).toHaveLength(0);
    expect(socket.readyState).toBe(0);

    gate.resolve();
    await flush();
    expect(FakeSocket.created).toHaveLength(1);
    expect(FakeSocket.created[0]!.url).toBe('wss://relay.example/api');
    expect(FakeSocket.created[0]!.protocols).toEqual(['verto']);
  });

  it('forwards the real socket events and state, and sends through it', async () => {
    const Gated = gateWebSocket(FakeSocket as never, async () => undefined);
    const socket = new Gated('wss://relay.example/api');
    const seen: string[] = [];
    for (const type of ['open', 'message', 'error', 'close']) {
      socket.addEventListener(type as never, ((event: { type: string }) => seen.push(event.type)) as never);
    }
    await flush();
    const real = FakeSocket.created[0]!;

    real.fire('open');
    expect(socket.readyState).toBe(1);
    socket.send('hello');
    expect(real.sent).toEqual(['hello']);
    real.fire('message', { type: 'message', data: '{}' });
    real.fire('error');
    real.fire('close');
    expect(seen).toEqual(['open', 'message', 'error', 'close']);
    expect(socket.readyState).toBe(3);
  });

  it('stops forwarding to a listener that was removed', async () => {
    const Gated = gateWebSocket(FakeSocket as never, async () => undefined);
    const socket = new Gated('wss://relay.example/api');
    const listener = jest.fn();
    socket.addEventListener('open', listener);
    socket.removeEventListener('open', listener);
    await flush();
    FakeSocket.created[0]!.fire('open');
    expect(listener).not.toHaveBeenCalled();
  });

  it('closes the real socket once it exists', async () => {
    const Gated = gateWebSocket(FakeSocket as never, async () => undefined);
    const socket = new Gated('wss://relay.example/api');
    await flush();
    socket.close(1000, 'bye');
    expect(FakeSocket.created[0]!.closed).toEqual([[1000, 'bye']]);
  });

  it('never opens a socket closed while held, and reports it closed', async () => {
    jest.useFakeTimers();
    try {
      const gate = deferred();
      const Gated = gateWebSocket(FakeSocket as never, () => gate.promise);
      const socket = new Gated('wss://relay.example/api');
      const onClose = jest.fn();
      socket.addEventListener('close', onClose);

      socket.close();
      expect(socket.readyState).toBe(3);
      jest.advanceTimersByTime(0);
      expect(onClose).toHaveBeenCalledTimes(1);

      gate.resolve();
      await flush();
      expect(FakeSocket.created).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('refuses a send before the socket is open, as a WebSocket does', () => {
    const Gated = gateWebSocket(FakeSocket as never, () => new Promise(() => undefined));
    const socket = new Gated('wss://relay.example/api');
    expect(() => socket.send('early')).toThrow(/not open/);
  });

  it('opens anyway when the gate fails', async () => {
    const Gated = gateWebSocket(FakeSocket as never, () => Promise.reject(new Error('no')));
    new Gated('wss://relay.example/api');
    await flush();
    expect(FakeSocket.created).toHaveLength(1);
  });
});
