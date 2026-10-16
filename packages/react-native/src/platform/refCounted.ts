/**
 * Shares one install of a process-wide shim among everyone who asked for it.
 *
 * The shims patch globals the SDK reads, so there is one install per process.
 * Every caller gets its own release function; the install is torn down when
 * the last one is released. Two platforms can be alive at once (two
 * providers, or the new and old provider of a `key` remount, where React
 * renders the new one before it runs the old one's cleanup), and disposing
 * either must not stop the other's feed.
 */
export function refCounted(install: () => () => void): () => () => void {
  let current: { teardown: () => void; users: number } | null = null;

  return () => {
    if (!current) {
      current = { teardown: install(), users: 0 };
    }
    const mine = current;
    mine.users += 1;
    let released = false;

    return (): void => {
      if (released) {
        return;
      }
      released = true;
      mine.users -= 1;
      if (mine.users === 0 && current === mine) {
        current = null;
        mine.teardown();
      }
    };
  };
}
