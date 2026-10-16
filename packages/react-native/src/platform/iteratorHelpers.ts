/**
 * The two ES2025 iterator helpers `@signalwire/js` calls, for runtimes that
 * lack them.
 *
 * The SDK calls them on `Map` iterators in `DirectoryManager`:
 *
 * ```js
 * Array.from(this._addressesInstances.values().map((address) => address.id));
 * this._addressesInstances.values().find((addr) => addr.name === name)?.id;
 * ```
 *
 * V8 has shipped `Iterator.prototype.map` and friends since Chrome 122, so the
 * browser SDK is right to use them. **Hermes has not**, so those calls throw
 * `values().map is not a function` — which surfaces as a crash the moment
 * anything touches the directory.
 *
 * This is the fifth thing that breaks the SDK under React Native, and unlike
 * the other four it is not an import-time failure: it lies dormant until a
 * code path reaches one of these calls.
 *
 * The polyfill goes on the realm-wide `%IteratorPrototype%`, so every library
 * in the app sees it. That is why it is only `map` and `find`, and why they
 * follow the spec where app code can tell the difference: the callback is
 * checked at the call, the index is passed, and the source iterator is
 * closed when the helper is returned early, when the callback throws, and
 * when `find` has its answer. Feature-detecting code that finds the other
 * helpers missing uses its own fallback, as it would on any engine without
 * them. Only missing methods are installed, so a Hermes release that ships
 * the real helpers takes precedence automatically.
 */

type Result = IteratorResult<unknown>;

interface Direct {
  iterator: Iterator<unknown>;
  next: () => Result;
}

/** The shared `%IteratorPrototype%`, reached through any built-in iterator. */
function iteratorPrototype(): Record<PropertyKey, unknown> | null {
  const arrayIterator = [][Symbol.iterator]();
  const arrayIteratorPrototype = Object.getPrototypeOf(arrayIterator) as object | null;
  const shared = arrayIteratorPrototype
    ? (Object.getPrototypeOf(arrayIteratorPrototype) as object | null)
    : null;
  return shared as Record<PropertyKey, unknown> | null;
}

function define(target: Record<PropertyKey, unknown>, name: string, value: unknown): void {
  if (typeof target[name] === 'function') {
    return;
  }
  Object.defineProperty(target, name, {
    value,
    writable: true,
    configurable: true,
    enumerable: false
  });
}

/** GetIteratorDirect: the iterator and its `next`, read once. */
function direct(target: unknown): Direct {
  if ((typeof target !== 'object' && typeof target !== 'function') || target === null) {
    throw new TypeError('Iterator helper called on a non-object');
  }
  const iterator = target as Iterator<unknown>;
  const next = iterator.next;
  return { iterator, next: () => next.call(iterator) as Result };
}

function close(iterator: Iterator<unknown>): void {
  const done = iterator.return;
  if (typeof done === 'function') {
    done.call(iterator);
  }
}

/** Closes after a throw: the original error wins over one from `return()`. */
function closeQuietly(iterator: Iterator<unknown>): void {
  try {
    close(iterator);
  } catch {
    // The caller rethrows the error that made us close.
  }
}

/** Closes the source and throws when `callback` is not callable. */
function requireCallable(iterator: Iterator<unknown>, callback: unknown, helper: string): void {
  if (typeof callback !== 'function') {
    closeQuietly(iterator);
    throw new TypeError(`Iterator.prototype.${helper} requires a function, got ${typeof callback}`);
  }
}

interface HelperState {
  next(): Result;
  return(): Result;
}

const DONE: Result = { value: undefined, done: true };

/**
 * Installs the iterator helpers the SDK relies on. Safe to call repeatedly.
 */
export function installIteratorHelpers(): void {
  const proto = iteratorPrototype();
  if (!proto || (typeof proto.map === 'function' && typeof proto.find === 'function')) {
    return;
  }

  const states = new WeakMap<object, HelperState>();
  const stateOf = (helper: unknown): HelperState => {
    const state = typeof helper === 'object' && helper !== null ? states.get(helper) : undefined;
    if (!state) {
      throw new TypeError('Not an iterator helper');
    }
    return state;
  };

  // %IteratorHelperPrototype%: inherits Symbol.iterator from %IteratorPrototype%.
  const helperPrototype = Object.create(proto, {
    next: {
      value: function next(this: unknown): Result {
        return stateOf(this).next();
      },
      writable: true,
      configurable: true
    },
    return: {
      value: function return_(this: unknown): Result {
        return stateOf(this).return();
      },
      writable: true,
      configurable: true
    },
    [Symbol.toStringTag]: { value: 'Iterator Helper', configurable: true }
  }) as object;

  define(proto, 'map', function map(this: unknown, mapper: unknown): object {
    const source = direct(this);
    requireCallable(source.iterator, mapper, 'map');
    const fn = mapper as (value: unknown, index: number) => unknown;
    let counter = 0;
    let done = false;

    const helper = Object.create(helperPrototype) as object;
    states.set(helper, {
      next(): Result {
        if (done) {
          return DONE;
        }
        const result = source.next();
        if (result.done) {
          done = true;
          return DONE;
        }
        try {
          return { value: fn(result.value, counter++), done: false };
        } catch (error) {
          done = true;
          closeQuietly(source.iterator);
          throw error;
        }
      },
      return(): Result {
        if (!done) {
          done = true;
          close(source.iterator);
        }
        return DONE;
      }
    });
    return helper;
  });

  define(proto, 'find', function find(this: unknown, predicate: unknown): unknown {
    const source = direct(this);
    requireCallable(source.iterator, predicate, 'find');
    const fn = predicate as (value: unknown, index: number) => unknown;
    let counter = 0;
    for (;;) {
      const result = source.next();
      if (result.done) {
        return undefined;
      }
      let matched: unknown;
      try {
        matched = fn(result.value, counter++);
      } catch (error) {
        closeQuietly(source.iterator);
        throw error;
      }
      if (matched) {
        close(source.iterator);
        return result.value;
      }
    }
  });
}
