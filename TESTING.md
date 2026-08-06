# TESTING.md

**Audience: an agent session starting cold on a machine that is not the one this
was built on.** Read this top to bottom before running anything. It assumes no
memory of the original session.

---

## 0. Orientation (read first, 60 seconds)

This repository is a single npm workspace; there is no sibling checkout. The
browser SDK it adapts is an ordinary dependency, read at
`node_modules/@signalwire/js` when you need to check its behaviour.

The package adapts the browser SDK to React Native *without forking it*: it
injects platform implementations and shims the globals the SDK probes. If a fix
seems to require editing the SDK, that is a signal to find an injection point or
a `typeof`-guarded global to shim instead.

### The five things that break `@signalwire/js` under React Native

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
   in the consuming app (Expo SDK 52 only — SDK 53+ handles them).
5. The SDK calls ES2025 iterator helpers (`Iterator.prototype.map`/`.find`) on
   Map iterators in `DirectoryManager`. V8 has them; **Hermes does not**.
   Unlike 1–3 this is not an import-time crash — it lies dormant until a code
   path touches the directory, then throws `values().map is not a function`.
   Handled by `installIteratorHelpers()`.

1–3 and 5 are all installed by the single side-effect import
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
| test | 54 core + 13 react-ui + 157 react-native + 23 react-native-ui = **247**, plus 37 server |
| bundle-check | `iOS Bundled … (~1090 modules)`, an `Android Bundled …` line, and a Vite `✓ built in …` |

**Do not treat the Android module count as a gate.** Both platforms export
concurrently against one Metro cache, and the Android figure tracks cache
warmth rather than the bundle: on this repo it has been observed at 1088 on a
cold cache and falling through the 800s, 600s and 400s on successive warm runs,
while iOS stays fixed. Clear `$TMPDIR/metro-cache` first if you want a
reproducible number, or just check that both platforms bundle without error.

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

### 2c. FORMER BLOCKER — probably fixed, still unverified

Under Expo SDK 52 this failed during configuration:

```
* What went wrong:
A problem occurred configuring project ':expo'.
> Could not get unknown property 'release' for SoftwareComponent container …
  (ExpoModulesCorePlugin.gradle line 95)
```

It was an **Expo toolchain version mismatch, not a bug in this package** — it
failed configuring `:expo`, before any of our code compiled. `expo-modules-core@2.2.3`
read `components.release` in a way current AGP no longer supports, and the
generated `build.gradle` pinned no AGP version, so AGP resolved to whatever was
newest.

The recommended fix was "upgrade to SDK 53+", and **the repo is now on SDK 54**,
which ships an `expo-modules-core` that handles current AGP. So this should no
longer reproduce — but **no Gradle build has been run on any machine since the
upgrade**, so treat that as expectation, not fact. If it still fails, pin AGP in
`example/android/build.gradle` and clear
`~/.gradle/caches/modules-2/files-2.1/com.android.tools.build`.

Record what actually happens here the first time someone runs it.

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

**Xcode 26 or newer is required** — any iOS 26 device needs it, and Xcode 16.x
cannot build SDK 54 anyway.

### The application identifier is not in the repo

Bundle identifiers must be globally unique across Apple's ecosystem and
registrable by *your* team, so no committed value can work for everyone — and an
internal one has no business in a repository heading for public release. The
example reads it from `SW_APP_ID`:

```bash
cd example
cp .env.example .env      # .env is gitignored
# then edit .env: SW_APP_ID=<a prefix your team controls>
```

`example/app.config.js` applies it to both `ios.bundleIdentifier` and
`android.package`. With nothing set it falls back to `com.example.swrnexample`,
which is fine for `expo export`, `verify` and the unit tests, but **will not
sign against a real Apple team** — you will get "the app identifier cannot be
registered to your team".

It is read when the Expo config is evaluated, so it must be present for
`expo prebuild` and `expo run:ios`, not merely at runtime. A `.env` in
`example/` is picked up automatically; exporting the variable works too.

With a paid Apple Developer account and automatic signing, Xcode registers the
App ID and provisioning profile on first build. Adding the Push Notifications
capability likewise updates the App ID in place, which is what checklist items
5–7 need — they require an explicit App ID, not a wildcard.

### Machine setup

Machine setup gotchas, both hit on a fresh macOS box:

- **Accept the Xcode licence first.** Until you do, `xcrun`, `simctl` and even
  `brew install cocoapods` fail with the same licence error, which makes the
  real cause easy to misread. Launching `Xcode.app` once and clicking Agree also
  installs the first-run components; `sudo xcodebuild -license accept` does the
  licence alone.
- **`pod` may be shadowed.** If the machine uses asdf/rbenv, its shim wins over
  Homebrew's and reports `No version is set for command pod`. Put Homebrew
  first — `export PATH=/opt/homebrew/bin:$PATH` — for prebuild, `pod install`
  and `expo run:ios`, since Expo shells out to `pod` itself.
- **Replacing Xcode.app removes its simulator runtimes.** Check with
  `xcrun simctl list runtimes`; if it is empty, fetch one through
  Xcode → Settings → Components or `xcodebuild -downloadPlatform iOS` (~8 GB).
- `expo prebuild` runs `pod install` at the end, and a cold CocoaPods cache
  makes that first run take well over ten minutes. Let it finish rather than
  interrupting it — a killed run leaves `ios/Pods` populated but no
  `Podfile.lock`, and you have to rerun `pod install` by hand.
- **A wedged `syspolicyd` looks exactly like a CocoaPods bug.** If `pod install`
  sits at 0% CPU with no network sockets and no child processes, check
  `ps -o %cpu -p $(pgrep syspolicyd)`. Gatekeeper validates every freshly
  downloaded binary, and when it spins at 100% the install blocks in `fcntl`
  inside dyld's `mapSegments` — in a *different* process, which is why the pod
  process itself looks idle. `sudo killall syspolicyd` clears it (the daemon
  respawns). It cost hours here before a stack sample showed it.

### The pod configuration that works

Verified on macOS 26.3.1 / Xcode 26.6 / Expo SDK 54 / RN 0.81.5:

```bash
cd example/ios
export PATH=/opt/homebrew/bin:$PATH
RCT_USE_RN_DEP=1 pod install
```

`RCT_USE_RN_DEP=1` pulls the third-party dependencies (boost, glog, fmt,
double-conversion) as prebuilt binaries. **Use it.** Without it, CocoaPods
compiles glog from source by running `./configure`, which blocks forever
reading a stdin that CocoaPods never writes to.

**Do not add `RCT_USE_PREBUILT_RNCORE=1`.** Precompiled React core is broken on
this toolchain — the `React-Core-prebuilt` umbrella header pulls in source-tree
headers that are not part of its module, and `-Wnon-modular-include-in-framework-module`
is promoted to an error:

```
error: include of non-modular header inside framework module 'React':
  Pods/Headers/Public/React-Core/React/RCTAnimationDriver.h
```

Building React core from source (the default) avoids it and costs only build
time.

If a run is interrupted, `rm -rf ios/Pods ios/build ios/Podfile.lock` before
retrying. The `~/Library/Caches/CocoaPods` cache survives, so it is a re-copy
rather than a re-download.

Before checklist items 5–7 can work at all:

1. Add the `AppDelegate` PushKit hook from `docs/native-setup.md`. The Expo
   plugin deliberately does not inject it (regex-patching Expo's Swift
   `AppDelegate` fails silently, which is worse than not generating it). Without
   it, a cold-start push cannot reach CallKit in time and iOS kills the process.

   **Use the Objective-C category, not a Swift `import RNCallKeep`.** On RN 0.81
   that import fails with "no such module" — callkeep's podspec does not expose
   a consumable Swift module, and bridging headers do not work around it
   ([callkeep#856](https://github.com/react-native-webrtc/react-native-callkeep/issues/856),
   open and unassigned since Aug 2025). The ObjC route is the only one known to
   work.
2. Xcode → Signing & Capabilities → add **Push Notifications** and **Background
   Modes** (Voice over IP + Audio). Push Notifications requires a **paid** Apple
   Developer Program membership; a free personal team cannot enable it, so
   items 5–7 are unreachable without one.
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
| Invite succeeds (verto 200), then silence; far end logs a media timeout | The offer contains an m-line the destination cannot answer — most often `video` (sendonly) against an audio-only resource | Dial `{ audio: true, video: false }`; check the offered m-lines before suspecting the network |
| `values().map is not a function` | Hermes lacks ES2025 iterator helpers (breakage 5) | Polyfills import missing or stale build |
| `DependencyError: Main peer connection not found` after a call ends | SDK-side: a getter that throws is read during teardown, e.g. when a server event arrives post-destroy | Cosmetic; not this package. Worth reporting upstream |
| ICE gathering times out; candidate list includes `100.x`/`fd7a:` addresses | A VPN (e.g. Tailscale) adds interfaces that slow gathering | Disable the VPN on the device, or accept slower setup |
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

---

## Reaching the support server from a device

A real device cannot reach the Mac's loopback, and the generated `Info.plist`
sets `NSAllowsArbitraryLoads=false` with `NSAllowsLocalNetworking=true`. That
combination decides what actually works:

| Route | Works? | Why |
| --- | --- | --- |
| `http://localhost:3000` | Simulator only | The device has its own loopback |
| `http://<LAN IP>:3000` | Yes, same Wi-Fi | Covered by `NSAllowsLocalNetworking`; expect an iOS "allow local network access" prompt on first launch |
| `http://100.x.y.z:3000` (Tailscale IP) | **No** | Tailscale uses `100.64.0.0/10` (CGNAT), which is not one of the private ranges `NSAllowsLocalNetworking` covers, so ATS blocks it |
| `https://<host>.<tailnet>.ts.net` | Yes | Real certificate, so plain ATS is satisfied; also avoids the local-network prompt |

The Tailscale route survives changing networks, which matters when the Mac and
the device are not on one Wi-Fi:

```bash
tailscale serve --bg 3000          # proxies https://<host>.<tailnet>.ts.net -> localhost:3000
tailscale serve status
tailscale serve --https=443 off    # when finished
```

Then set the app's endpoint, remembering that `EXPO_PUBLIC_` is what makes Expo
inline it into the bundle:

```bash
# example/.env
EXPO_PUBLIC_SW_TOKEN_URL=https://<host>.<tailnet>.ts.net/token
```

Verify from the Mac before blaming the app — a token minted over HTTPS proves
the whole chain except the device's own network:

```bash
curl -X POST https://<host>.<tailnet>.ts.net/token \
  -H 'content-type: application/json' -d '{}'
```
