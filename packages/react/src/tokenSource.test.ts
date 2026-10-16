import { TokenFetchError, TokenSource, toExpiryMs } from './tokenSource';

import type { FetchedToken, TokenStatus } from './tokenSource';

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);

/** A fetchToken whose results are queued by the test. */
function queuedFetch(): {
  fetchToken: jest.Mock<Promise<FetchedToken>, []>;
  resolveNext: (token: FetchedToken) => void;
  rejectNext: (error: unknown) => void;
} {
  const waiting: Array<{ resolve: (token: FetchedToken) => void; reject: (error: unknown) => void }> = [];
  const fetchToken = jest.fn(
    () =>
      new Promise<FetchedToken>((resolve, reject) => {
        waiting.push({ resolve, reject });
      })
  );
  return {
    fetchToken,
    resolveNext: (token) => waiting.shift()?.resolve(token),
    rejectNext: (error) => waiting.shift()?.reject(error)
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('toExpiryMs', () => {
  it('reads seconds, milliseconds and ISO strings', () => {
    expect(toExpiryMs(NOW / 1000)).toBe(NOW);
    expect(toExpiryMs(NOW)).toBe(NOW);
    expect(toExpiryMs(String(NOW / 1000))).toBe(NOW);
    expect(toExpiryMs(new Date(NOW).toISOString())).toBe(NOW);
  });

  it('treats a missing or unreadable expiry as unknown', () => {
    expect(toExpiryMs(undefined)).toBeUndefined();
    expect(toExpiryMs('soon')).toBeUndefined();
    expect(toExpiryMs(Number.NaN)).toBeUndefined();
    expect(toExpiryMs(0)).toBeUndefined();
  });
});

describe('TokenSource', () => {
  it('authenticates with the fetched token and its expiry, and offers refresh()', async () => {
    const fetchToken = jest.fn(async () => ({ token: 'jwt-1', expiresAt: NOW / 1000 + 3600 }));
    const source = new TokenSource(fetchToken);

    await expect(source.credentialProvider.authenticate()).resolves.toEqual({
      token: 'jwt-1',
      expiry_at: NOW + 3_600_000
    });
    expect(typeof source.credentialProvider.refresh).toBe('function');
    expect(source.status).toEqual({ state: 'ready', expiresAt: NOW + 3_600_000, error: null });
    source.dispose();
  });

  it('leaves expiry_at out when the app gives no expiry', async () => {
    const source = new TokenSource(async () => ({ token: 'jwt-1' }));
    await expect(source.credentialProvider.authenticate()).resolves.toEqual({ token: 'jwt-1' });
    source.dispose();
  });

  it('retries a failed fetch with growing delays until it succeeds', async () => {
    const { fetchToken, resolveNext, rejectNext } = queuedFetch();
    const source = new TokenSource(fetchToken, { random: () => 1 });
    const states: TokenStatus['state'][] = [];
    source.status$.subscribe((status) => {
      if (states[states.length - 1] !== status.state) {
        states.push(status.state);
      }
    });

    const credential = source.credentialProvider.authenticate();
    await flush();
    rejectNext(new Error('offline'));
    await flush();
    expect(source.status.state).toBe('retrying');
    expect(source.status.error?.message).toBe('offline');

    // First retry after 1 s.
    jest.advanceTimersByTime(999);
    await flush();
    expect(fetchToken).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    await flush();
    expect(fetchToken).toHaveBeenCalledTimes(2);
    rejectNext(new TokenFetchError('bad gateway', { status: 502 }));
    await flush();

    // Second after 2 s.
    jest.advanceTimersByTime(1999);
    await flush();
    expect(fetchToken).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(1);
    await flush();
    expect(fetchToken).toHaveBeenCalledTimes(3);
    resolveNext({ token: 'jwt-ok' });

    await expect(credential).resolves.toEqual({ token: 'jwt-ok' });
    expect(source.status).toEqual({ state: 'ready', expiresAt: undefined, error: null });
    expect(states).toEqual(['fetching', 'retrying', 'ready']);
    source.dispose();
  });

  it('caps the delay between attempts at 30 s', async () => {
    const fetchToken = jest.fn(async (): Promise<FetchedToken> => {
      throw new Error('down');
    });
    const source = new TokenSource(fetchToken, { random: () => 1 });
    void source.credentialProvider.authenticate().catch(() => undefined);
    await flush();

    for (let attempt = 1; attempt <= 8; attempt++) {
      jest.advanceTimersByTime(Math.min(1000 * 2 ** (attempt - 1), 30_000));
      await flush();
    }
    expect(fetchToken).toHaveBeenCalledTimes(9);
    jest.advanceTimersByTime(29_999);
    await flush();
    expect(fetchToken).toHaveBeenCalledTimes(9);
    jest.advanceTimersByTime(1);
    await flush();
    expect(fetchToken).toHaveBeenCalledTimes(10);
    source.dispose();
  });

  it.each([401, 403])('stops at a %s and reports it as unauthorized', async (status) => {
    const refused = new TokenFetchError('Unauthorized', { status });
    const fetchToken = jest.fn(async (): Promise<FetchedToken> => {
      throw refused;
    });
    const source = new TokenSource(fetchToken);

    await expect(source.credentialProvider.authenticate()).rejects.toBe(refused);
    expect(source.status).toEqual({ state: 'unauthorized', expiresAt: undefined, error: refused });
    jest.advanceTimersByTime(120_000);
    await flush();
    expect(fetchToken).toHaveBeenCalledTimes(1);
    source.dispose();
  });

  it('recognises a status on any error the app throws, not only TokenFetchError', async () => {
    const refused = Object.assign(new Error('forbidden'), { status: 403 });
    const source = new TokenSource(async () => {
      throw refused;
    });
    await expect(source.credentialProvider.authenticate()).rejects.toBe(refused);
    expect(source.status.state).toBe('unauthorized');
    source.dispose();
  });

  it('treats a response without a token as a failure, and retries', async () => {
    const { fetchToken, resolveNext } = queuedFetch();
    const source = new TokenSource(fetchToken, { random: () => 1 });
    const credential = source.credentialProvider.authenticate();
    await flush();
    resolveNext({ token: '' });
    await flush();
    expect(source.status.state).toBe('retrying');
    expect(source.status.error?.message).toMatch(/no token/);
    jest.advanceTimersByTime(1000);
    await flush();
    resolveNext({ token: 'jwt-2' });
    await expect(credential).resolves.toEqual({ token: 'jwt-2' });
    source.dispose();
  });

  it('renews shortly before expiry and hands the renewed token to refresh()', async () => {
    let n = 0;
    const fetchToken = jest.fn(async () => {
      n += 1;
      return { token: `jwt-${n}`, expiresAt: Date.now() + 120_000 };
    });
    const source = new TokenSource(fetchToken);
    await source.credentialProvider.authenticate();
    expect(fetchToken).toHaveBeenCalledTimes(1);

    // 120 s lifetime: renewed 24 s (a fifth) before it ends.
    jest.advanceTimersByTime(95_999);
    await flush();
    expect(fetchToken).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    await flush();
    expect(fetchToken).toHaveBeenCalledTimes(2);

    // The SDK's own timer asks for it 5 s before expiry: no second fetch.
    jest.advanceTimersByTime(19_000);
    await expect(source.credentialProvider.refresh!()).resolves.toEqual({
      token: 'jwt-2',
      expiry_at: NOW + 96_000 + 120_000
    });
    expect(fetchToken).toHaveBeenCalledTimes(2);
    source.dispose();
  });

  it('fetches on refresh() when nothing was renewed ahead', async () => {
    let n = 0;
    const source = new TokenSource(async () => {
      n += 1;
      return { token: `jwt-${n}` };
    });
    await source.credentialProvider.authenticate();
    await expect(source.credentialProvider.refresh!()).resolves.toEqual({ token: 'jwt-2' });
    await expect(source.credentialProvider.refresh!()).resolves.toEqual({ token: 'jwt-3' });
    source.dispose();
  });

  it('shares one fetch between a renewal and a refresh() made while it runs', async () => {
    const { fetchToken, resolveNext } = queuedFetch();
    const source = new TokenSource(fetchToken);
    const first = source.credentialProvider.authenticate();
    await flush();
    resolveNext({ token: 'jwt-1', expiresAt: Date.now() + 100_000 });
    await first;

    jest.advanceTimersByTime(80_000); // renewal starts at 80 s (lead 20 s)
    await flush();
    expect(fetchToken).toHaveBeenCalledTimes(2);
    expect(source.status.state).toBe('renewing');
    const refreshed = source.credentialProvider.refresh!();
    await flush();
    expect(fetchToken).toHaveBeenCalledTimes(2);
    resolveNext({ token: 'jwt-2', expiresAt: Date.now() + 100_000 });
    await expect(refreshed).resolves.toMatchObject({ token: 'jwt-2' });
    // Handed out once: the next refresh fetches again.
    const again = source.credentialProvider.refresh!();
    await flush();
    expect(fetchToken).toHaveBeenCalledTimes(3);
    resolveNext({ token: 'jwt-3' });
    await expect(again).resolves.toEqual({ token: 'jwt-3' });
    source.dispose();
  });

  it('renewIfDue() renews a token near or past its expiry, and leaves a fresh one alone', async () => {
    const fetchToken = jest.fn(async () => ({ token: 'jwt', expiresAt: Date.now() + 3_600_000 }));
    const source = new TokenSource(fetchToken);
    await source.credentialProvider.authenticate();

    source.renewIfDue();
    await flush();
    expect(fetchToken).toHaveBeenCalledTimes(1);

    // Timers do not run while a phone app is suspended: the clock moves on
    // without the renewal firing.
    jest.setSystemTime(NOW + 3_590_000);
    source.renewIfDue();
    await flush();
    expect(fetchToken).toHaveBeenCalledTimes(2);
    source.dispose();
  });

  it('renewIfDue() retries a waiting fetch now instead of after its backoff', async () => {
    const { fetchToken, rejectNext, resolveNext } = queuedFetch();
    const source = new TokenSource(fetchToken, { random: () => 1 });
    const credential = source.credentialProvider.authenticate();
    await flush();
    for (let i = 0; i < 5; i++) {
      rejectNext(new Error('offline'));
      await flush();
      jest.advanceTimersByTime(1000 * 2 ** i);
      await flush();
    }
    rejectNext(new Error('offline'));
    await flush();
    expect(fetchToken).toHaveBeenCalledTimes(6);

    source.renewIfDue();
    await flush();
    expect(fetchToken).toHaveBeenCalledTimes(7);
    resolveNext({ token: 'jwt-ok' });
    await expect(credential).resolves.toEqual({ token: 'jwt-ok' });
    source.dispose();
  });

  it('stops retrying and renewing once disposed', async () => {
    const fetchToken = jest.fn(async (): Promise<FetchedToken> => {
      throw new Error('offline');
    });
    const source = new TokenSource(fetchToken);
    const credential = source.credentialProvider.authenticate();
    await flush();
    source.dispose();
    await expect(credential).rejects.toThrow(/disposed/);
    jest.advanceTimersByTime(120_000);
    await flush();
    expect(fetchToken).toHaveBeenCalledTimes(1);
  });
});
