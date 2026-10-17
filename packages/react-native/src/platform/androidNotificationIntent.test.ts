/**
 * The ringing notification's Answer on Android
 * (android/…/NotificationIntent.java and IncomingCallNotificationModule),
 * compiled and run with the JDK against stand-ins for the Android classes.
 *
 * A pushed call can ring while the app has no activity: the push starts the
 * process, and the app's task is still in Recents. The Answer then starts
 * the singleTask launcher activity into that task, so Android recreates it
 * from the task's original intent and hands the Answer intent over as a new
 * intent, before the activity is resumed. The module dropped a new intent
 * when React had no current activity yet, and the resumed activity's own
 * intent carries no call: Answer did nothing and the call kept ringing
 * (emulator, 2026-10-17, simulated FCM push with the app killed).
 */
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

const PKG = join(__dirname, '../../android/src/main/java/com/signalwire/reactnative');
const hasJdk = spawnSync('javac', ['-version']).status === 0;
const withJdk = hasJdk ? it : it.skip;
if (!hasJdk) {
  console.warn('androidNotificationIntent: no javac on PATH; the Java behaviour tests are skipped');
}

const STUBS: Record<string, string> = {
  'android/util/Log.java': `package android.util;
public final class Log {
  public static int d(String tag, String msg) { System.err.println("D " + tag + ": " + msg); return 0; }
}`,
  'androidx/annotation/Nullable.java': `package androidx.annotation;
public @interface Nullable {}`,
  'android/content/Intent.java': `package android.content;
import java.util.HashMap;
public class Intent {
  private final HashMap<String, String> extras = new HashMap<>();
  public Intent putExtra(String k, String v) { extras.put(k, v); return this; }
  public boolean hasExtra(String k) { return extras.containsKey(k); }
  public String getStringExtra(String k) { return extras.get(k); }
  public void removeExtra(String k) { extras.remove(k); }
}`,
  'com/signalwire/reactnative/Probe.java': `package com.signalwire.reactnative;
import android.content.Intent;
public class Probe {
  public static void main(String[] args) {
    StringBuilder out = new StringBuilder();
    NotificationIntent.Actions actions = new NotificationIntent.Actions() {
      public void answer(String uuid) { out.append("answer:").append(uuid).append(';'); }
    };
    Intent intent = new Intent();
    if (args.length > 0) intent.putExtra(NotificationIntent.EXTRA_CALL_UUID, args[0]);
    if (args.length > 1) intent.putExtra(NotificationIntent.EXTRA_ACTION, args[1]);
    out.append(NotificationIntent.handle(intent, "test", actions)).append(';');
    // A second delivery of the same intent (resume after new intent) acts once.
    out.append(NotificationIntent.handle(intent, "test", actions)).append(';');
    out.append(NotificationIntent.handle(null, "test", actions));
    System.out.print(out);
  }
}`
};

let dir = '';
let classes = '';
const run = (...args: string[]): string =>
  execFileSync('java', ['-cp', classes, 'com.signalwire.reactnative.Probe', ...args], { encoding: 'utf8' });

beforeAll(() => {
  if (!hasJdk) {
    return;
  }
  const base = join(__dirname, '../../node_modules/.cache');
  mkdirSync(base, { recursive: true });
  dir = mkdtempSync(join(base, 'sw-notification-intent-'));
  classes = join(dir, 'classes');
  const files = [join(PKG, 'NotificationIntent.java')];
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

describe('NotificationIntent (Android)', () => {
  withJdk('answers the call an Answer intent names, once', () => {
    expect(run('uuid-1', 'answer')).toBe('answer:uuid-1;true;false;false');
  });

  withJdk('a tap on the notification body opens the app and answers nothing', () => {
    expect(run('uuid-1', 'show')).toBe('true;false;false');
  });

  withJdk('ignores an intent without a call', () => {
    expect(run()).toBe('false;false;false');
  });

  it('handles a new intent whether or not React has a current activity yet', () => {
    const module = readFileSync(join(PKG, 'IncomingCallNotificationModule.java'), 'utf8');
    const onNewIntent = module.match(/public void onNewIntent\(Intent intent\) \{([\s\S]*?)\n {2}\}/);
    expect(onNewIntent).not.toBeNull();
    expect(onNewIntent![1]).not.toMatch(/getCurrentActivity/);
    expect(onNewIntent![1]).toMatch(/NotificationIntent\.handle\(/);
  });
});
