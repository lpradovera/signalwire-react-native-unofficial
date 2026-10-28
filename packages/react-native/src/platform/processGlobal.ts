/**
 * One value per process, shared by every bundle copy of this package.
 *
 * tsup builds each subpath entry (`.`, `./callkit`, `./audio`) as a
 * self-contained bundle, so a module-scope `let` exists once per entry an app
 * imports: two CallKit bridges, two audio controllers, two native device
 * subscriptions. `globalThis` is the one scope every copy shares, so state
 * that must be per-process lives there, under a key, through these helpers.
 */
type Holder = Record<string, unknown>;

/** The value under `key`, created on first use. A cached `null` or `false` is kept. */
export function processGlobal<T>(key: string, create: () => T): T {
  const holder = globalThis as unknown as Holder;
  if (!(key in holder)) {
    holder[key] = create();
  }
  return holder[key] as T;
}

/** The value under `key`, if one was created; never creates it. */
export function peekProcessGlobal<T>(key: string): T | undefined {
  return (globalThis as unknown as Holder)[key] as T | undefined;
}

/** Forgets the value under `key` (test seams). */
export function dropProcessGlobal(key: string): void {
  delete (globalThis as unknown as Holder)[key];
}
