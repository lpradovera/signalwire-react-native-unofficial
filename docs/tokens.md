# Tokens: `fetchToken`

A subscriber token (SAT) expires. When it does, the client can no longer
connect, and a device that cannot connect does not receive calls. Give the
provider a `fetchToken` and it keeps the client supplied:

```tsx
import { SignalWireProvider, TokenFetchError } from '@signalwire/react-native';

async function fetchToken() {
  const response = await fetch('https://example.com/token', {
    method: 'POST',
    headers: { authorization: `Bearer ${session}` }
  });
  if (!response.ok) {
    // A 401 or 403 is reported as 'unauthorized' and not retried.
    throw new TokenFetchError(`Token server returned ${response.status}`, {
      status: response.status
    });
  }
  const body = await response.json();
  // Unix seconds, epoch milliseconds or an ISO 8601 string.
  return { token: body.token, expiresAt: body.expires_at };
}

// Module scope (or useCallback): a new identity rebuilds the client.
<SignalWireProvider fetchToken={fetchToken} callKit>
  <App />
</SignalWireProvider>;
```

The provider:

- **Connects with it.** The token goes to the SDK with `expiry_at` set from
  `expiresAt`, and `@signalwire/js`'s `CredentialProvider.refresh()` is wired
  to the same function, so the SDK's own renewal (5 s before expiry) and its
  reconnects re-mint through it too.
- **Renews ahead of expiry.** A fifth of the token's lifetime before it
  expires (at least 10 s, at most 60 s), it fetches the next token, which the
  SDK's refresh then receives without waiting on the network.
- **Renews when timers missed it.** Timers do not run while a phone app is
  suspended. When the app returns to the foreground (`AppState` on React
  Native, `visibilitychange` in a browser) and when a call push arrives
  (with `callKit`), a token near or past its expiry is renewed at once, and a
  fetch waiting out its backoff is retried at once.
- **Retries.** A failed fetch is retried after 1 s, 2 s, 4 s and so on, up to
  every 30 s, until it succeeds. It never gives up on its own: a network drop
  at renewal time costs a delay, not the session.
- **Stops at 401 and 403.** An error with a `status` (or `statusCode`) of 401
  or 403 means the user is no longer allowed a token. It is not retried; it is
  reported, so the app can show it and sign the user in again.

## Showing the state

```tsx
const { tokenStatus, error } = useSignalWire();
```

`tokenStatus` is `null` with a `credentialProvider`. With `fetchToken`:

| `state` | Meaning |
| --- | --- |
| `'fetching'` | Getting the first token. |
| `'ready'` | The current token is good. `expiresAt` says until when. |
| `'renewing'` | Getting the next token while the current one still works. |
| `'retrying'` | A fetch failed (`tokenStatus.error`) and is being retried. |
| `'unauthorized'` | The server refused with 401 or 403. Also set as `error`. |

Show `'unauthorized'`: until the app passes a new `fetchToken` (after
signing the user in again), the client cannot connect, so calls cannot reach
this device. A call push that rings in this state is logged as an error.

## Push wake-ups

The same source feeds the push path. On a cold start the provider mounts and
connects through `fetchToken` like any launch. A push that wakes a suspended
app starts the renewal the moment the registry sees it, rather than when the
SDK's reconnect asks, and answering from the lock screen (which leaves the app
in the background) is covered the same way.

## A plain `credentialProvider`

Still supported, unchanged: an app that passes
`credentialProvider={{ authenticate: async () => ({ token }) }}` behaves as
before, with no renewal. Pass one or the other, not both.

## The example server

`POST /token` mints with an expiry and returns it:

```json
{ "token": "eyJ...", "reference": "alice", "expires_at": 1792180800 }
```

`expires_at` is Unix seconds. The lifetime is `TOKEN_TTL_SECONDS` (default
7200, two hours). Set it to `120` to watch renewals happen in a device test.

`fetchToken` is alpha API: it may change with the push redesign.
