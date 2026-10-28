package com.signalwire.reactnative;

import android.content.Context;
import android.content.Intent;
import android.util.Log;

import androidx.annotation.NonNull;

import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;

/**
 * Starts and stops {@link CallForegroundService} for JavaScript
 * (src/react/CallForegroundService.tsx), which asks while a call that is not
 * in Telecom is in progress.
 */
public class CallForegroundServiceModule extends ReactContextBaseJavaModule {
  static final String NAME = "SignalWireCallService";

  CallForegroundServiceModule(ReactApplicationContext context) {
    super(context);
  }

  @NonNull
  @Override
  public String getName() {
    return NAME;
  }

  /** Starts the service, or promotes it again if a start was refused; idempotent. */
  @ReactMethod
  public void start() {
    Context context = getReactApplicationContext();
    try {
      context.startService(new Intent(context, CallForegroundService.class));
    } catch (IllegalStateException | SecurityException error) {
      // Android 8+ refuses a service start from the background.
      Log.w(CallForegroundService.TAG, "Could not start the call service: " + error);
    }
  }

  @ReactMethod
  public void stop() {
    Context context = getReactApplicationContext();
    context.stopService(new Intent(context, CallForegroundService.class));
  }

  @Override
  public void invalidate() {
    // The React context is going (a reload, or the process ending its JS):
    // nothing is left to stop the service when the call ends.
    stop();
    super.invalidate();
  }
}
