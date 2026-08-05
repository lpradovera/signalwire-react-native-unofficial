# Running the example natively

Everything in `docs/device-testing.md` needs a native build. This is how to get
one, plus what I already set up on this machine and the one blocker I hit.

## Already installed on this dev box

You do not need to redo these:

| Tool | Version | Location |
| --- | --- | --- |
| JDK | OpenJDK 17.0.19 (headless) | `/usr/lib/jvm/java-17-openjdk-amd64` |
| Android SDK | platform-tools, platforms;android-35, build-tools;35.0.0, ndk;27.1.12297006 | `~/Android/Sdk` |

Add these to your shell profile:

```bash
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
export ANDROID_HOME=$HOME/Android/Sdk
export PATH=$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH
```

**No emulator system image is installed, and no emulator has been run.** That
was deliberate — a running AVD holds 2–4 GB of RAM and the KVM device, and this
box is your working machine. Install one only when you want it:

```bash
sdkmanager "system-images;android-35;google_apis;x86_64" "emulator"
avdmanager create avd -n sw-test -k "system-images;android-35;google_apis;x86_64"
emulator -avd sw-test -no-snapshot -no-boot-anim     # add -no-window if headless
```

An emulator is fine for ConnectionService, permissions, and confirming the app
boots. It is **not** useful for real audio or camera, so checklist items 1, 2, 8
and 9 still need hardware.

## Android build

```bash
cd example
npx expo prebuild --platform android --clean
echo "sdk.dir=$ANDROID_HOME" > android/local.properties
cd android && ./gradlew assembleDebug
```

### The blocker I hit — read this first

`./gradlew assembleDebug` currently fails during configuration:

```
* What went wrong:
A problem occurred configuring project ':expo'.
> Could not get unknown property 'release' for SoftwareComponent container
  of type org.gradle.api.internal.component.DefaultSoftwareComponentContainer.
  (ExpoModulesCorePlugin.gradle line 95)
```

This is an Expo-toolchain version mismatch, **not** something in
`@signalwire/react-native` — it fails while configuring `:expo`, before any of
our code is compiled. The generated `example/android/build.gradle` line 18 has:

```gradle
classpath('com.android.tools.build:gradle')
```

with **no version pin**, so AGP resolves to whatever is newest. My Gradle cache
ended up holding both 8.5.0 and 8.6.0. `expo-modules-core@2.2.3` reads
`components.release` in an `afterEvaluate` block, which newer AGP no longer
populates the same way.

**I did not verify a fix** — I stopped before churning your machine further, so
treat everything below as untested leads, in the order I would try them:

1. **Pin AGP** to the version Expo SDK 52 was built against. In
   `example/android/build.gradle`:
   ```gradle
   classpath('com.android.tools.build:gradle:8.6.0')
   ```
   Then `./gradlew --stop && ./gradlew assembleDebug`.
2. **Pin the Gradle wrapper** if that is not enough — `gradle-wrapper.properties`
   is currently `gradle-8.10.2-all.zip`, which is right for SDK 52; leave it
   unless step 1 fails.
3. **Upgrade Expo to SDK 53+**, where `expo-modules-core` handles current AGP
   and `unstable_enablePackageExports` is on by default, letting you delete that
   line from `metro.config.js`. This is the cleanest long-term route and I would
   do it before shipping.
4. Clear caches between attempts: `rm -rf ~/.gradle/caches/modules-2/files-2.1/com.android.tools.build`.

Once it builds:

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb logcat -c && adb logcat | grep -iE "signalwire|ReactNative|AndroidRuntime"
```

## iOS build

**Requires macOS.** This box is Linux, so none of the iOS path — CallKit, VoIP
push, `Info.plist` behaviour at runtime — has been executed anywhere.

```bash
cd example
npx expo prebuild --platform ios --clean
cd ios && pod install
open SignalWireRNExample.xcworkspace
```

Then, before checklist items 5–7 will work at all:

1. Add the `AppDelegate` PushKit hook from `docs/native-setup.md`. Without it a
   cold-start push cannot reach CallKit in time and iOS kills the process.
2. In Xcode → Signing & Capabilities, add **Push Notifications** and
   **Background Modes** (Voice over IP + Audio).
3. Create a VoIP services certificate in the Apple Developer portal and wire it
   to whatever sends your pushes.

CallKit does not work in the iOS Simulator. Items 3–7 need a real device.

## Getting a token

The example takes a subscriber token pasted into its first screen. Mint one with:

```bash
curl -X POST https://<space>.signalwire.com/api/fabric/subscribers/tokens \
  -u "<project-id>:<api-token>" \
  -H "Content-Type: application/json" \
  -d '{"reference":"rn-example"}'
```

For the push path the token is not enough — you also need a backend that
registers the device token with SignalWire and sends a payload carrying
`call_id`. That contract is described in the README under "Native call UI"; the
package deliberately owns neither half.

## What is worth checking first

The single highest-value observation once the app launches is simply **that it
launches**. Three of the four RN breakages I found are import-time crashes, so a
clean boot to the token screen confirms all of them at once:

- `crypto.getRandomValues` present for the SDK's bundled `uuid`
- `URL` keeping the `destination:` scheme
- `CustomEvent` / `window.dispatchEvent` present when `@signalwire/js` loads

If it boots, `installBaseGlobals()` and the polyfills entry are doing their job
on a real Hermes runtime. If it red-screens on startup, capture the stack — it
will name which of the three is missing.
