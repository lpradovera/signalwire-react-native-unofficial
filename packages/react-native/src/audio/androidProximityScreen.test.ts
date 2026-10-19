/**
 * The proximity screen-off lock (android/…/ProximityScreenModule.java),
 * compiled and run with the JDK against stand-ins for PowerManager and React
 * Native's module base class.
 *
 * Why it exists: on a Pixel 6 Pro (Android 17) the screen stayed on at the ear
 * on the receiver. The package blanked it only after JavaScript saw a "near"
 * event from incall-manager's own sensor listener and asked for the lock, and
 * no lock was ever taken. The system dialer instead holds a
 * PROXIMITY_SCREEN_OFF_WAKE_LOCK for as long as the call is on the receiver
 * and lets the system watch the sensor; the module does the same, told by
 * startTelecomCallScreen when the route is the receiver.
 */
// A module, not a script: its names stay out of the other test files' scope.
export {};

// Node built-ins, typed here: this package's tsconfig has no Node types
// (the same pattern as reactNativeWebRTCSurface.test.ts).
declare const __dirname: string;
const { execFileSync, spawnSync } = require('child_process') as {
  execFileSync(file: string, args: string[], options?: { encoding: 'utf8' }): string;
  spawnSync(file: string, args: string[]): { status: number | null };
};
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('fs') as {
  mkdirSync(path: string, options?: { recursive: boolean }): void;
  mkdtempSync(prefix: string): string;
  readFileSync(path: string, enc: string): string;
  rmSync(path: string, options?: { recursive: boolean; force: boolean }): void;
  writeFileSync(path: string, data: string): void;
};
const { join } = require('path') as { join(...parts: string[]): string };

const MAIN = join(__dirname, '../../android/src/main');
const PKG = join(MAIN, 'java/com/signalwire/reactnative');
const SOURCE = join(PKG, 'ProximityScreenModule.java');

const hasJdk = spawnSync('javac', ['-version']).status === 0;
// Without a JDK the behaviour can't run; say so instead of passing silently.
const withJdk = hasJdk ? it : it.skip;
if (!hasJdk) {
  console.warn('androidProximityScreen: no javac on PATH; the Java behaviour tests are skipped');
}

// PowerManager's real values (android.os.PowerManager).
const STUBS: Record<string, string> = {
  'android/util/Log.java': `package android.util;
public final class Log {
  public static int d(String tag, String msg) { return 0; }
  public static int w(String tag, String msg, Throwable t) { System.out.println("warn " + t.getMessage()); return 0; }
}`,
  'android/content/Context.java': `package android.content;
public abstract class Context {
  public static final String POWER_SERVICE = "power";
  public abstract Object getSystemService(String name);
}`,
  'android/os/PowerManager.java': `package android.os;
public final class PowerManager {
  public static final int PROXIMITY_SCREEN_OFF_WAKE_LOCK = 0x00000020;
  public static final int RELEASE_FLAG_WAIT_FOR_NO_PROXIMITY = 1 << 0;
  public final boolean supported;
  public final boolean throwOnAcquire;
  public int created;
  public PowerManager(boolean supported, boolean throwOnAcquire) {
    this.supported = supported;
    this.throwOnAcquire = throwOnAcquire;
  }
  public boolean isWakeLockLevelSupported(int level) { return supported && level == PROXIMITY_SCREEN_OFF_WAKE_LOCK; }
  public WakeLock newWakeLock(int levelAndFlags, String tag) {
    created++;
    System.out.println("new level=" + levelAndFlags + " tag=" + tag);
    return new WakeLock();
  }
  public final class WakeLock {
    private boolean held;
    private boolean counted = true;
    public void setReferenceCounted(boolean value) { counted = value; }
    public boolean isHeld() { return held; }
    public void acquire() {
      if (throwOnAcquire) throw new SecurityException("Neither user 10123 nor current process has android.permission.WAKE_LOCK.");
      if (counted) throw new IllegalStateException("reference counted");
      held = true;
      System.out.println("acquire");
    }
    public void release(int flags) {
      held = false;
      System.out.println("release flags=" + flags);
    }
  }
}`,
  'androidx/annotation/NonNull.java': `package androidx.annotation;
public @interface NonNull {}`,
  'androidx/annotation/Nullable.java': `package androidx.annotation;
public @interface Nullable {}`,
  'com/facebook/react/bridge/ReactApplicationContext.java': `package com.facebook.react.bridge;
public class ReactApplicationContext extends android.content.Context {
  private final Object power;
  public ReactApplicationContext(Object power) { this.power = power; }
  public Object getSystemService(String name) { return "power".equals(name) ? power : null; }
}`,
  'com/facebook/react/bridge/ReactContextBaseJavaModule.java': `package com.facebook.react.bridge;
public abstract class ReactContextBaseJavaModule {
  public ReactContextBaseJavaModule(ReactApplicationContext context) {}
  public abstract String getName();
  public void invalidate() {}
}`,
  'com/facebook/react/bridge/ReactMethod.java': `package com.facebook.react.bridge;
public @interface ReactMethod { boolean isBlockingSynchronousMethod() default false; }`,
  // Runs a script of steps: hold, hold, release, release-far, end (invalidate).
  'com/signalwire/reactnative/Probe.java': `package com.signalwire.reactnative;
import android.os.PowerManager;
import com.facebook.react.bridge.ReactApplicationContext;
public class Probe {
  public static void main(String[] args) {
    PowerManager power = new PowerManager(!args[0].equals("unsupported"), args[0].equals("denied"));
    ProximityScreenModule module = new ProximityScreenModule(new ReactApplicationContext(power));
    System.out.println("name " + module.getName());
    for (int i = 1; i < args.length; i++) {
      System.out.println("> " + args[i]);
      switch (args[i]) {
        case "hold": module.setHeld(true, false); break;
        case "release": module.setHeld(false, false); break;
        case "release-far": module.setHeld(false, true); break;
        case "end": module.invalidate(); break;
        default: throw new IllegalArgumentException(args[i]);
      }
    }
  }
}`
};

let dir = '';
let classes = '';

function run(...args: string[]): string[] {
  return execFileSync('java', ['-cp', classes, 'com.signalwire.reactnative.Probe', ...args], { encoding: 'utf8' })
    .trim()
    .split('\n');
}

beforeAll(() => {
  if (!hasJdk) {
    return;
  }
  // Repo-local scratch (node_modules is ignored), never the shared temp dir.
  const base = join(__dirname, '../../node_modules/.cache');
  mkdirSync(base, { recursive: true });
  dir = mkdtempSync(join(base, 'sw-proximity-'));
  classes = join(dir, 'classes');
  const files = [SOURCE];
  for (const [path, body] of Object.entries(STUBS)) {
    const file = join(dir, 'src', path);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, body);
    files.push(file);
  }
  execFileSync('javac', ['-d', classes, ...files]);
}, 60_000);

afterAll(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('ProximityScreenModule (Android)', () => {
  withJdk('is the SignalWireProximityScreen module, with one unreferenced PROXIMITY_SCREEN_OFF_WAKE_LOCK', () => {
    expect(run('supported').slice(0, 2)).toEqual(['new level=32 tag=SignalWire:proximity', 'name SignalWireProximityScreen']);
  });

  withJdk('holds the lock once however often it is asked, and releases it at once', () => {
    expect(run('supported', 'hold', 'hold', 'release', 'release').slice(2)).toEqual([
      '> hold',
      'acquire',
      '> hold',
      '> release',
      'release flags=0',
      '> release'
    ]);
  });

  withJdk('releases it once the phone has left the ear when asked to (the end of a call)', () => {
    expect(run('supported', 'hold', 'release-far').slice(2)).toEqual([
      '> hold',
      'acquire',
      '> release-far',
      'release flags=1'
    ]);
  });

  withJdk('never leaves the screen blanked when the React instance goes away', () => {
    expect(run('supported', 'hold', 'end').slice(2)).toEqual(['> hold', 'acquire', '> end', 'release flags=0']);
  });

  withJdk('does nothing on a device without proximity screen-off (no sensor)', () => {
    expect(run('unsupported', 'hold', 'release', 'end')).toEqual([
      'name SignalWireProximityScreen',
      '> hold',
      '> release',
      '> end'
    ]);
  });

  withJdk('keeps the call going when the lock is refused (no WAKE_LOCK permission)', () => {
    const out = run('denied', 'hold', 'release');
    expect(out.slice(2)).toEqual([
      '> hold',
      'warn Neither user 10123 nor current process has android.permission.WAKE_LOCK.',
      '> release'
    ]);
  });

  it('is registered with the package, and the library declares WAKE_LOCK', () => {
    const pkg = readFileSync(join(PKG, 'SignalWireReactNativePackage.java'), 'utf8');
    expect(pkg).toContain('new ProximityScreenModule(context)');
    const manifest = readFileSync(join(MAIN, 'AndroidManifest.xml'), 'utf8');
    expect(manifest).toContain('<uses-permission android:name="android.permission.WAKE_LOCK" />');
  });
});
