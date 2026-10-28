/**
 * Lets async code wait for the SDK connection without polling.
 *
 * The owning hook calls `set()` with `isConnected` whenever it changes; a
 * `wait()` resolves `true` on that call, or `false` at its timeout. The loop
 * this replaces checked a ref every 150 ms, so a cold-start bridge answer
 * dialled up to 150 ms after the connection, while the caller sat on
 * ringback, and woke the JS thread up to 100 times doing it.
 */
export class ConnectionGate {
  private connected = false;
  private readonly waiters = new Set<(connected: boolean) => void>();

  get isConnected(): boolean {
    return this.connected;
  }

  set(connected: boolean): void {
    this.connected = connected;
    if (connected) {
      for (const release of [...this.waiters]) {
        release(true);
      }
    }
  }

  wait(timeoutMs: number): Promise<boolean> {
    if (this.connected) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const release = (connected: boolean): void => {
        clearTimeout(timer);
        this.waiters.delete(release);
        resolve(connected);
      };
      const timer = setTimeout(() => release(false), timeoutMs);
      this.waiters.add(release);
    });
  }
}
