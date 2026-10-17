package com.signalwire.reactnative;

import androidx.annotation.NonNull;

import com.facebook.react.ReactPackage;
import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.uimanager.ViewManager;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/** Autolinked entry point for @signalwire/react-native's Android code. */
public class SignalWireReactNativePackage implements ReactPackage {
  public SignalWireReactNativePackage() {
    // Before any native module exists: WebRTCModule reads the trials when it
    // is created. See WebRTCFieldTrials.
    WebRTCFieldTrials.apply();
  }

  @NonNull
  @Override
  public List<NativeModule> createNativeModules(@NonNull ReactApplicationContext context) {
    return Arrays.<NativeModule>asList(
        new IncomingCallNotificationModule(context),
        new CallAudioStateModule(context),
        new CallForegroundServiceModule(context));
  }

  @NonNull
  @Override
  public List<ViewManager> createViewManagers(@NonNull ReactApplicationContext context) {
    return Collections.emptyList();
  }
}
