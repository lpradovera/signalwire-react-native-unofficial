# Native setup

The Expo config plugin covers most of this automatically:

```json
{ "plugins": [["@signalwire/react-native", { "enableCallKit": true, "enableVoipPush": true }]] }
```

Bare React Native projects apply the same changes by hand — see the tables below.
The `AppDelegate` section applies to **every** project using VoIP push,
including Expo, because the plugin deliberately does not patch that source file.

## iOS: reporting a VoIP push before JavaScript boots

On a cold start the JS bundle is not running when a VoIP push arrives, and iOS
terminates the app if CallKit is not told about the call almost immediately.
Report it from native code.

```objc
#import <PushKit/PushKit.h>
#import "RNCallKeep.h"

- (void)pushRegistry:(PKPushRegistry *)registry
didReceiveIncomingPushWithPayload:(PKPushPayload *)payload
             forType:(PKPushType)type
withCompletionHandler:(void (^)(void))completion
{
  NSDictionary *data = payload.dictionaryPayload;
  NSString *uuid       = data[@"uuid"];
  NSString *callId     = data[@"call_id"];
  NSString *handle     = data[@"from"] ?: @"Unknown";
  NSString *callerName = data[@"from_name"] ?: @"Unknown caller";

  [RNCallKeep reportNewIncomingCall:uuid
                             handle:handle
                         handleType:@"generic"
                           hasVideo:NO
                localizedCallerName:callerName
                    supportsHolding:YES
                       supportsDTMF:YES
                   supportsGrouping:NO
                 supportsUngrouping:NO
                        fromPushKit:YES
                            payload:@{@"callId": callId ?: @""}
              withCompletionHandler:completion];
}
```

Your push payload **must** include the SignalWire `call_id`. The JS side reads it
from callkeep's `didDisplayIncomingCall` event and calls
`getCallKit().reportIncomingPush({ callId, from, fromName })`, which is how
`CallRegistry` fuses the native entry with the SDK call.

Expo SDK 52 uses a Swift `AppDelegate`; add the equivalent Swift method, or
create a small Objective-C category. The config plugin does not patch this file
because regex-patching a Swift `AppDelegate` is fragile and fails silently.

## iOS: Info.plist

Applied by the plugin. For bare projects:

| Key | Value |
| --- | --- |
| `NSMicrophoneUsageDescription` | Why your app needs the microphone |
| `NSCameraUsageDescription` | Why your app needs the camera |
| `UIBackgroundModes` | `audio` (always), plus `voip` when using VoIP push |

Enable the **Push Notifications** capability and, for VoIP push, the
**Voice over IP** background mode in Xcode.

## Android: AndroidManifest.xml

Applied by the plugin. For bare projects:

```xml
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.CAMERA" />
<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MICROPHONE" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
<uses-permission android:name="android.permission.WAKE_LOCK" />

<!-- Native call UI only -->
<uses-permission android:name="android.permission.BIND_TELECOM_CONNECTION_SERVICE" />
<uses-permission android:name="android.permission.MANAGE_OWN_CALLS" />
<uses-permission android:name="android.permission.READ_PHONE_STATE" />
```

Also register `react-native-callkeep`'s `ConnectionService` per its
[Android setup guide](https://github.com/react-native-webrtc/react-native-callkeep).

## Android: waking on a data message

FCM data messages reach a killed app through a headless task. Register it
alongside your root component, not inside it:

```js
// index.js, after the polyfills import
import messaging from '@react-native-firebase/messaging';
import { getCallKit } from '@signalwire/react-native/callkit';

messaging().setBackgroundMessageHandler(async (message) => {
  const { call_id: callId, from, from_name: fromName } = message.data ?? {};
  getCallKit().reportIncomingPush({ callId, from, fromName });
});
```

**Android 14+ restricts starting a foreground service from the background.** For
the locked-device case, present the call with a full-screen intent
(`USE_FULL_SCREEN_INTENT`) rather than relying on a foreground service start;
callkeep's self-managed ConnectionService mode handles this when configured.

## Metro and Babel

Both are required regardless of platform. See the README section
"Two build-config requirements":

```js
// metro.config.js
config.resolver.unstable_enablePackageExports = true;
```

```js
// babel.config.js
plugins: ['@babel/plugin-transform-class-static-block'];
```

## react-native-webrtc

This package does not configure `react-native-webrtc` itself. Expo projects
should add its own config plugin:

```json
{ "plugins": ["@config-plugins/react-native-webrtc"] }
```

Bare projects follow the
[react-native-webrtc installation guide](https://github.com/react-native-webrtc/react-native-webrtc/blob/master/Documentation/GettingStarted.md).
