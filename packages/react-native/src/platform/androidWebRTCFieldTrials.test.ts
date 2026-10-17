/**
 * The WebRTC field trial the Android package sets
 * (android/…/WebRTCFieldTrials.java), compiled and run with the JDK against
 * a stand-in for react-native-webrtc's WebRTCModuleOptions.
 *
 * Why the trial: libwebrtc's Android network monitor restarts whenever a new
 * ICE gathering session starts with none running, which is what answering an
 * inbound call does. Until the platform's network callbacks arrive again it
 * knows no network, so it reports every interface as unavailable, the
 * session gathers no candidates ("Machine has no networks; no ports will be
 * allocated"), and the SDK never sends its answer: the caller hears ringing
 * until it gives up. On the Android emulator 2 of 4 inbound answers failed so
 * (2026-10-17); with the trial, 5 of 5 connected.
 */
import { execFileSync, spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

const PKG = join(__dirname, '../../android/src/main/java/com/signalwire/reactnative');
const SOURCE = join(PKG, 'WebRTCFieldTrials.java');
const TRIAL = 'WebRTC-AndroidNetworkMonitor-IsAdapterAvailable/Disabled/';

const hasJdk = spawnSync('javac', ['-version']).status === 0;
// Without a JDK the behaviour can't run; say so instead of passing silently.
const withJdk = hasJdk ? it : it.skip;
if (!hasJdk) {
  console.warn('androidWebRTCFieldTrials: no javac on PATH; the Java behaviour tests are skipped');
}

const STUBS: Record<string, string> = {
  'android/util/Log.java': `package android.util;
public final class Log {
  public static int i(String tag, String msg) { System.err.println("I " + tag + ": " + msg); return 0; }
  public static int w(String tag, String msg) { System.err.println("W " + tag + ": " + msg); return 0; }
  public static int w(String tag, String msg, Throwable t) { System.err.println("W " + tag + ": " + msg + " " + t); return 0; }
}`,
  'com/oney/WebRTCModule/WebRTCModuleOptions.java': `package com.oney.WebRTCModule;
public class WebRTCModuleOptions {
  private static WebRTCModuleOptions instance;
  public String fieldTrials;
  public static WebRTCModuleOptions getInstance() {
    if (instance == null) instance = new WebRTCModuleOptions();
    return instance;
  }
}`,
  'com/signalwire/reactnative/Probe.java': `package com.signalwire.reactnative;
import com.oney.WebRTCModule.WebRTCModuleOptions;
public class Probe {
  public static void main(String[] args) {
    if (args[0].equals("merge")) {
      System.out.print(WebRTCFieldTrials.withAdapterCheckOff(args.length > 1 ? args[1] : null));
      return;
    }
    if (args.length > 1) WebRTCModuleOptions.getInstance().fieldTrials = args[1];
    WebRTCFieldTrials.apply();
    WebRTCFieldTrials.apply();
    System.out.print(WebRTCModuleOptions.getInstance().fieldTrials);
  }
}`
};

let dir = '';
let classes = '';

function run(...args: string[]): string {
  return execFileSync('java', ['-cp', classes, 'com.signalwire.reactnative.Probe', ...args], { encoding: 'utf8' });
}

beforeAll(() => {
  if (!hasJdk) {
    return;
  }
  // Repo-local scratch (node_modules is ignored), never the shared temp dir.
  const base = join(__dirname, '../../node_modules/.cache');
  mkdirSync(base, { recursive: true });
  dir = mkdtempSync(join(base, 'sw-field-trials-'));
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

describe('WebRTCFieldTrials (Android)', () => {
  withJdk('turns the adapter check off when the app set no trials', () => {
    expect(run('merge')).toBe(TRIAL);
    expect(run('merge', '')).toBe(TRIAL);
  });

  withJdk("keeps the app's own trials and adds this one after them", () => {
    expect(run('merge', 'WebRTC-Foo/Enabled/')).toBe(`WebRTC-Foo/Enabled/${TRIAL}`);
    // A string missing its closing slash still yields a valid trial string.
    expect(run('merge', 'WebRTC-Foo/Enabled')).toBe(`WebRTC-Foo/Enabled/${TRIAL}`);
  });

  withJdk('leaves the trial alone when the app chose it itself', () => {
    const own = 'WebRTC-AndroidNetworkMonitor-IsAdapterAvailable/Enabled/';
    expect(run('merge', own)).toBe(own);
  });

  withJdk("sets it on react-native-webrtc's options, once, however often it runs", () => {
    expect(run('apply')).toBe(TRIAL);
    expect(run('apply', 'WebRTC-Foo/Enabled/')).toBe(`WebRTC-Foo/Enabled/${TRIAL}`);
  });

  it('runs when the package is created, before any WebRTC module exists', () => {
    const pkg = readFileSync(join(PKG, 'SignalWireReactNativePackage.java'), 'utf8');
    // The package object is built with the app's package list, before React
    // Native creates any native module; WebRTCModule reads the trials in its
    // constructor (PeerConnectionFactory.initialize).
    expect(pkg).toMatch(/public SignalWireReactNativePackage\(\)\s*\{[^}]*WebRTCFieldTrials\.apply\(\);/s);
  });
});
