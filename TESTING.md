# TESTING.md

**Audience: an agent session starting cold on a machine that is not the one this
was built on.** Read this top to bottom before running anything. It assumes no
memory of the original session.

---

## 0. Orientation (read first, 60 seconds)

Two sibling repos live under `sw-rn-client/`:

| Path | What it is | May I edit it? |
| --- | --- | --- |
| `signalwire-typescript-web/` | The SignalWire browser SDK (`@signalwire/js` v4) | **No. Read-only reference.** |
| `signalwire-react-native/` | `@signalwire/react-native` — the package under test | Yes |

The package adapts the browser SDK to React Native *without forking it*: it
injects platform implementations and shims the globals the SDK probes. If a fix
seems to require editing the SDK, that is a signal to find an injection point or
a `typeof`-guarded global to shim instead.

Work from `signalwire-react-native/`. Branch: `feat/initial-package`.

### The four things that break `@signalwire/js` under React Native

Memorise these — most runtime failures trace back to one of them, and three are
import-time crashes:

1. The SDK's entry point runs `window.dispatchEvent(new CustomEvent(...))` at
   import, guarded only by `typeof window !== 'undefined'`. RN passes that guard
   but has neither symbol. Handled by `installBaseGlobals()`.
2. The SDK parses dial destinations with `new URL('destination:' + addr)`. RN's
   built-in `URL` drops the scheme. Handled by `react-native-url-polyfill`.
3. The SDK bundles `uuid`, which needs `crypto.getRandomValues`. Hermes has none.
   Handled by `react-native-get-random-values`.
4. The SDK's ESM build uses ES2022 static class blocks that `babel-preset-expo`
   does not transform. Handled by `@babel/plugin-transform-class-static-block`
   in the consuming app.

1–3 are all installed by the single side-effect import
`@signalwire/react-native/polyfills`, which **must be the first line** of the
app's entry file.

---

## 1. Tier 0 — headless checks (no device, no simulator, any OS)

These are the contract. They passed at the last commit and must keep passing.
Run them first on any machine; if they fail, stop and fix before going native.

```bash
cd signalwire-react-native
npm ci          # or `npm install` if the lockfile is stale
npm run verify
```

`npm run verify` runs, in order: `build` → `lint` → `type-check` (package,
example **and** server) → `test` → `bundle-check`.

**Build comes first, and must stay first.** The example typechecks against the
built `dist/`, and `bundle-check` resolves the package through its exports map.
On a fresh clone neither exists, so any other order fails with
`Cannot find module '@signalwire/react-native'` — which is not a real breakage,
just a stale ordering.

**Expected output — treat any deviation as a regression:**

| Step | Expect |
| --- | --- |
| build | Four packages, each `ESM/CJS/DTS ⚡️ Build success` |
| lint | no output, exit 0 |
| type-check | no `error TS` lines, across seven workspaces |
| test | 50 core + 13 react-ui + 147 react-native + 21 react-native-ui = **231**, plus 29 server |
| bundle-check | `iOS Bundled … (~876 modules)`, `Android Bundled … (~874 modules)`, and a Vite `✓ built in …` |

The four packages are `@signalwire/react` (universal core), `@signalwire/react-ui`
(browser Lit wrappers), `@signalwire/react-native` (platform layer) and
`@signalwire/react-native-ui` (native components). Build order matters — see below.

Two more, run separately because they hit the network:

```bash
npm run verify:package    # publint + are-the-types-wrong on the built tarball
npm run verify:prebuild   # real `expo prebuild`; asserts the config plugin applied
```

`verify:package` expects `All good!` from publint and **every row green** from
attw, including `node10` — `typesVersions` covers classic resolution. The
`./app.plugin.js` entrypoint is excluded from attw on purpose: it is an Expo
build-time entry consumed by the config-plugin loader, not by TypeScript, so it
legitimately ships no declarations.

`verify:prebuild` expects:
`✓ 10 Android permissions and 4 iOS Info.plist entries applied by the plugin.`
It needs no Xcode, Android SDK, or CocoaPods — prebuild only generates sources.

Coverage, if you want it:

```bash
cd packages/react-native
npx jest --coverage --silent --collectCoverageFrom='src/**/*.{ts,tsx}' \
  --collectCoverageFrom='!src/**/*.test.*'
```
Last measured: **94.9% statements overall**, `CallKeepBridge` 95.7%. A drop in
`CallKeepBridge` or `CallRegistry` matters more than the headline number — those
two hold all the call-state logic.

---

## 2. Tier 1 — native Android build

### 2a. Bootstrap the toolchain

On a fresh Linux box (skip anything already present):

```bash
sudo apt-get install -y openjdk-17-jdk-headless

export ANDROID_HOME=$HOME/Android/Sdk
mkdir -p $ANDROID_HOME/cmdline-tools
curl -sSLo /tmp/cmdtools.zip \
  https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
unzip -q -o /tmp/cmdtools.zip -d $ANDROID_HOME/cmdline-tools
mv -f $ANDROID_HOME/cmdline-tools/cmdline-tools $ANDROID_HOME/cmdline-tools/latest

export PATH=$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64

yes | sdkmanager --licenses > /dev/null
sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0" "ndk;27.1.12297006"
```

macOS: `brew install --cask temurin@17` plus Android Studio, same SDK packages.

### 2b. Build

```bash
cd example
npx expo prebuild --platform android --clean
echo "sdk.dir=$ANDROID_HOME" > android/local.properties
cd android && ./gradlew assembleDebug
```

### 2c. KNOWN BLOCKER — expect this to fail on the first attempt

```
* What went wrong:
A problem occurred configuring project ':expo'.
> Could not get unknown property 'release' for SoftwareComponent container …
  (ExpoModulesCorePlugin.gradle line 95)
```

This is an **Expo toolchain version mismatch, not a bug in this package** — it
fails configuring `:expo`, before any of our code compiles. Cause:
`example/android/build.gradle` line 18 is
`classpath('com.android.tools.build:gradle')` with **no version pin**, so AGP
resolves to whatever is newest, and `expo-modules-core@2.2.3` reads
`components.release` in a way current AGP no longer supports.

**None of the fixes below have been verified.** Try in order, stopping when the
build succeeds, and record which one worked:

1. Pin AGP in `example/android/build.gradle`:
   `classpath('com.android.tools.build:gradle:8.6.0')`, then
   `./gradlew --stop && ./gradlew assembleDebug`.
2. If that fails, clear the AGP cache and retry:
   `rm -rf ~/.gradle/caches/modules-2/files-2.1/com.android.tools.build`.
3. If still failing, **upgrade Expo to SDK 53+**. This is the cleanest fix and
   worth doing regardless: SDK 53 ships an `expo-modules-core` that handles
   current AGP, and turns on `unstable_enablePackageExports` by default — which
   lets you delete that line from `example/metro.config.js` and drop one of the
   two documented consumer requirements from the README.

Leave the Gradle wrapper at `gradle-8.10.2-all.zip` unless step 1 fails; that
version is correct for SDK 52.

### 2d. Emulator — only if you need it, and mind the host

**Do not leave an AVD running on a machine someone is working on.** It holds
2–4 GB of RAM and the KVM device. Check `/dev/kvm` is readable (add yourself to
the `kvm` group if not) and prefer `-no-window` on a headless box.

```bash
sdkmanager "system-images;android-35;google_apis;x86_64" "emulator"
avdmanager create avd -n sw-test -k "system-images;android-35;google_apis;x86_64"
emulator -avd sw-test -no-snapshot -no-boot-anim -no-window &
adb wait-for-device
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb logcat -c && adb logcat | grep -iE "signalwire|ReactNative|AndroidRuntime"
```

An emulator covers ConnectionService, permissions, and app boot. It gives you
**no real audio or camera**, so checklist items 1, 2, 8, 9 still need hardware.

### 2e. Device clouds — what they can and cannot do

Checked August 2026. **A device cloud does not remove the need for a Mac**, and
for a calling app it cannot verify the thing that matters.

BrowserStack specifically:

| Capability | Reality |
| --- | --- |
| Audio **injection** (mic in) | **Android only** — every published doc is `audio-injection-android`, no iOS equivalent. Select devices. And "when the audio file is playing, you do not hear the audio." |
| Audio **output** (hearing the device) | Only documented for *Live* (browser), not App Live (native apps). iOS limited to certain iPads on 13.4+; Android limited to Samsung Internet and Firefox, not Chrome. |
| Push notifications | Supported both platforms — but the banner is invisible (their video streaming), so check Notification Center. Nothing documented about VoIP/PushKit. |
| iOS dev builds | "Install app via TestFlight" — i.e. it presupposes a signed build from macOS or EAS. |
| Building your app | Not offered. It runs binaries. |

So it cannot verify checklist items 1, 2, 8 or 9 (anything audible), and item 5
(cold-start VoIP push) is not something to trust from a shared, frequently-reset
cloud device.

**What it is good for:** confirming the app *boots* across a device matrix.
That is higher-signal here than it sounds — three of the four RN breakages in
section 0 are import-time crashes, so a clean launch clears all three at once.
Worth buying after the basics work on one physical handset, not before.

**The better spend at this stage is EAS Build**, which produces a signed `.ipa`
on Expo's macOS machines and removes the actual blocker. It would likely also
sidestep the AGP failure in section 2c, since it builds from known-good
toolchain images rather than whatever AGP resolves to locally.

---

## 3. Tier 2 — iOS

**Requires macOS.** Nothing on the iOS path — CallKit, VoIP push, `Info.plist`
at runtime — has been executed on any machine yet. It is entirely unvalidated.

```bash
cd example
npx expo prebuild --platform ios --clean
cd ios && pod install
open SignalWireRNExample.xcworkspace
```

Before checklist items 5–7 can work at all:

1. Add the `AppDelegate` PushKit hook from `docs/native-setup.md`. The Expo
   plugin deliberately does not inject it (regex-patching Expo SDK 52's Swift
   `AppDelegate` fails silently, which is worse than not generating it). Without
   it, a cold-start push cannot reach CallKit in time and iOS kills the process.
2. Xcode → Signing & Capabilities → add **Push Notifications** and **Background
   Modes** (Voice over IP + Audio).
3. Create a VoIP services certificate and wire it to your push sender.

**CallKit does not work in the iOS Simulator.** Items 3–7 need a real device.

---

## 4. Tier 3 — real calls

Get a subscriber token:

```bash
curl -X POST https://<space>.signalwire.com/api/fabric/subscribers/tokens \
  -u "<project-id>:<api-token>" \
  -H "Content-Type: application/json" \
  -d '{"reference":"rn-example"}'
```

Paste it into the example app's first screen. Then work through
**`docs/device-testing.md`** — 12 scenarios with a sign-off table. Fill the table
in and commit it.

The push scenarios (5–7) additionally need the full push chain built — see
**`docs/push-setup.md`**. SignalWire has no push infrastructure, so the webhook,
the token store and the sender are all yours, and the payload must **carry
`call_id`**. The package
owns neither half by design; `reportIncomingPush({ callId, from, fromName })` is
the entire contract. Without `call_id` the registry falls back to "the single
unmatched inbound call within 20s" and logs a warning — which breaks as soon as
two calls overlap, and is exactly what scenario 12 is designed to catch.

### The single most valuable observation

**That the app boots to the token screen at all.** Three of the four RN
breakages are import-time crashes, so a clean launch confirms all of them on a
real Hermes runtime in one shot. If it red-screens on startup, capture the stack
— it will name which one is missing.

---

## 5. Failure triage

| Symptom | Cause | Fix |
| --- | --- | --- |
| `PolyfillNotInstalledError` | `@signalwire/react-native/polyfills` missing or not first | Make it line 1 of `index.js` |
| Red screen: `CustomEvent is not defined` | Polyfills entry did not run before `@signalwire/js` | Same as above |
| `Unable to resolve module @signalwire/react-native/polyfills` | Metro package exports off | `resolver.unstable_enablePackageExports = true` |
| `Static class blocks are not enabled` | Babel plugin missing | Add `@babel/plugin-transform-class-static-block` |
| `dial()` reaches the wrong address | `react-native-url-polyfill` missing | Check the polyfills import |
| `MissingPeerDependencyError` | Optional peer absent **or installed but not linked** | Install, then `expo prebuild --clean` / fresh pod install |
| Call connects but is silent (iOS) | Audio started before `didActivateAudioSession` | The bridge gates on it; if you start media yourself, wait for it too |
| Stuck entry in the iOS call log | Push never fused and `tick()` did not run | Check `CallKeepBridge` tick timer; covered by `CallKeepBridge.ios.test.ts` |
| Network loss not detected | `@react-native-community/netinfo` absent | Install it; pass `platform={{ netInfo: true }}` |
| Gradle `Could not get unknown property 'release'` | Expo/AGP mismatch, **not this package** | Section 2c |

---

## 6. Ground rules for the next session

- **Never edit `signalwire-typescript-web/`.** Shim or inject instead.
- Do not claim anything passes without pasting the command output. Tier 0 is
  cheap; run it rather than assuming.
- Jest gotchas in this repo, both already hit once: a `jest.mock` factory that
  closes over an outer `const` reads it **before initialization** — use
  `jest.mock(path)` automock, or build the mock inside the factory. And `uuid`
  v14 is ESM-only in every build, so it must stay in `transformIgnorePatterns`.
- Heavy or long-running native work on a shared machine: ask first. An emulator
  or a full Gradle build is not free.
- Record results by updating the sign-off table in `docs/device-testing.md` and
  the "which fix worked" note in section 2c, then commit.
