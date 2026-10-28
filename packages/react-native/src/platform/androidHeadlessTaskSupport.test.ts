/**
 * HeadlessTaskSupportModule (android/…/HeadlessTaskSupportModule.java),
 * compiled and run with the JDK against stand-ins for the React Native
 * classes.
 *
 * React Native's bridgeless runtime registers no HeadlessJsTaskSupport
 * module, so a headless task never reports that it finished and runs until
 * its timeout: 60 s for React Native Firebase's messaging task, whose service
 * is started with START_REDELIVER_INTENT. A process death inside that minute
 * restarted the service and redelivered the FCM message, so an answered or
 * declined call rang again with a spent bridge token (emulator, 2026-10-17,
 * real FCM). The module supplies the finish, for bridgeless contexts only.
 */
// A module, not a script: its names stay out of the other test files' scope.
export {};

// Node built-ins, typed here: this package's tsconfig has no Node types.
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
  console.warn('androidHeadlessTaskSupport: no javac on PATH; the Java behaviour tests are skipped');
}

const STUBS: Record<string, string> = {
  'android/util/Log.java': `package android.util;
public final class Log {
  public static int w(String tag, String msg) { System.err.println("W " + tag + ": " + msg); return 0; }
}`,
  'androidx/annotation/NonNull.java': `package androidx.annotation;
public @interface NonNull {}`,
  'com/facebook/react/module/annotations/ReactModule.java': `package com.facebook.react.module.annotations;
public @interface ReactModule { String name(); }`,
  'com/facebook/react/bridge/NativeModule.java': `package com.facebook.react.bridge;
public interface NativeModule { String getName(); }`,
  'com/facebook/react/bridge/Promise.java': `package com.facebook.react.bridge;
public interface Promise { void resolve(Object value); }`,
  'com/facebook/react/bridge/ReactContext.java': `package com.facebook.react.bridge;
public class ReactContext {
  private final boolean bridgeless;
  public ReactContext(boolean bridgeless) { this.bridgeless = bridgeless; }
  public boolean isBridgeless() { return bridgeless; }
}`,
  'com/facebook/react/bridge/ReactApplicationContext.java': `package com.facebook.react.bridge;
public class ReactApplicationContext extends ReactContext {
  public ReactApplicationContext(boolean bridgeless) { super(bridgeless); }
}`,
  'com/facebook/fbreact/specs/NativeHeadlessJsTaskSupportSpec.java': `package com.facebook.fbreact.specs;
import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
public abstract class NativeHeadlessJsTaskSupportSpec implements NativeModule {
  public static final String NAME = "HeadlessJsTaskSupport";
  private final ReactApplicationContext context;
  public NativeHeadlessJsTaskSupportSpec(ReactApplicationContext context) { this.context = context; }
  public String getName() { return NAME; }
  protected final ReactApplicationContext getReactApplicationContext() { return context; }
  public abstract void notifyTaskFinished(double taskId);
  public abstract void notifyTaskRetry(double taskId, Promise promise);
}`,
  'com/facebook/react/jstasks/HeadlessJsTaskContext.java': `package com.facebook.react.jstasks;
import com.facebook.react.bridge.ReactContext;
import java.util.HashSet;
import java.util.Set;
public class HeadlessJsTaskContext {
  public static final HeadlessJsTaskContext INSTANCE = new HeadlessJsTaskContext();
  public static ReactContext lastContext;
  public final Set<Integer> running = new HashSet<>();
  public final StringBuilder log = new StringBuilder();
  public static HeadlessJsTaskContext getInstance(ReactContext context) { lastContext = context; return INSTANCE; }
  public synchronized boolean isTaskRunning(int id) { return running.contains(id); }
  public synchronized void finishTask(int id) { running.remove(id); log.append("finish:").append(id).append(';'); }
  public synchronized boolean retryTask(int id) { log.append("retry:").append(id).append(';'); return true; }
}`,
  'com/signalwire/reactnative/Probe.java': `package com.signalwire.reactnative;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.jstasks.HeadlessJsTaskContext;
public class Probe {
  public static void main(String[] args) {
    StringBuilder out = new StringBuilder();
    ReactApplicationContext bridgeless = new ReactApplicationContext(true);
    out.append("bridgeless=").append(HeadlessTaskSupportModule.forContext(bridgeless).size()).append(';');
    out.append("bridge=").append(HeadlessTaskSupportModule.forContext(new ReactApplicationContext(false)).size()).append(';');
    HeadlessTaskSupportModule module = (HeadlessTaskSupportModule) HeadlessTaskSupportModule.forContext(bridgeless).get(0);
    out.append("name=").append(module.getName()).append(';');
    HeadlessJsTaskContext tasks = HeadlessJsTaskContext.INSTANCE;
    tasks.running.add(7);
    module.notifyTaskFinished(7.0);
    module.notifyTaskFinished(7.0);
    module.notifyTaskFinished(9.0);
    out.append(tasks.log).append("running=").append(tasks.running).append(';');
    out.append("context=").append(HeadlessJsTaskContext.lastContext == bridgeless).append(';');
    tasks.running.add(3);
    module.notifyTaskRetry(3.0, value -> out.append("retry3=").append(value).append(';'));
    module.notifyTaskRetry(4.0, value -> out.append("retry4=").append(value).append(';'));
    System.out.print(out);
  }
}`
};

let dir = '';
let classes = '';

beforeAll(() => {
  if (!hasJdk) {
    return;
  }
  const base = join(__dirname, '../../node_modules/.cache');
  mkdirSync(base, { recursive: true });
  dir = mkdtempSync(join(base, 'sw-headless-task-'));
  classes = join(dir, 'classes');
  const files = [join(PKG, 'HeadlessTaskSupportModule.java')];
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

describe('HeadlessTaskSupportModule (Android)', () => {
  withJdk('finishes a running task once, under the HeadlessJsTaskSupport name, bridgeless only', () => {
    const out = execFileSync('java', ['-cp', classes, 'com.signalwire.reactnative.Probe'], { encoding: 'utf8' });
    expect(out).toBe(
      'bridgeless=1;bridge=0;name=HeadlessJsTaskSupport;finish:7;running=[];context=true;retry3=true;retry4=false;'
    );
  });

  it('the package adds it to its native modules', () => {
    const pkg = readFileSync(join(PKG, 'SignalWireReactNativePackage.java'), 'utf8');
    expect(pkg).toMatch(/HeadlessTaskSupportModule\.forContext\(context\)/);
  });
});
