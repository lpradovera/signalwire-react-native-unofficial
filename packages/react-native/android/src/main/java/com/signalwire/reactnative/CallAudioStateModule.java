package com.signalwire.reactnative;

import android.annotation.SuppressLint;
import android.bluetooth.BluetoothDevice;
import android.os.Build;
import android.telecom.CallAudioState;
import android.telecom.Connection;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableArray;
import com.facebook.react.bridge.WritableMap;

/**
 * Reads a call's audio state as Telecom has it: the route, the routes Telecom
 * can switch the call to, and the Bluetooth device in use.
 *
 * Stock react-native-callkeep sends only the route (`didChangeAudioRoute`'s
 * `output`), and its getAudioRoutes() lists AudioManager's devices rather than
 * the routes Telecom offers the call, so the package reads the call's
 * CallAudioState itself. The SignalWire callkeep fork sends the routes and the
 * Bluetooth device with each report; this reader still gives the state before
 * the first report. The connection is looked up through callkeep's
 * VoiceConnectionService by reflection (see IncomingCallNotificationModule),
 * so this library still builds without callkeep.
 */
public class CallAudioStateModule extends ReactContextBaseJavaModule {
  static final String NAME = "SignalWireCallAudio";

  /** Telecom's routes in the order they are listed, by CallAudioState.audioRouteToString's names. */
  private static final int[] ROUTES = {
    CallAudioState.ROUTE_EARPIECE,
    CallAudioState.ROUTE_WIRED_HEADSET,
    CallAudioState.ROUTE_BLUETOOTH,
    CallAudioState.ROUTE_SPEAKER
  };

  CallAudioStateModule(ReactApplicationContext context) {
    super(context);
  }

  @NonNull
  @Override
  public String getName() {
    return NAME;
  }

  /**
   * Resolves `{ route, available, bluetoothName }` for the callkeep call
   * `uuid`, or null when callkeep has no such connection or Telecom has not
   * given it an audio state yet. `route` and `available` use
   * CallAudioState.audioRouteToString's names (`EARPIECE`, `WIRED_HEADSET`,
   * `BLUETOOTH`, `SPEAKER`), as callkeep's `didChangeAudioRoute` does.
   */
  // CallAudioState is deprecated from API 34 for CallEndpoint, which callkeep
  // 4.3.16 doesn't use. Telecom still keeps a connection's CallAudioState and
  // calls onCallAudioStateChanged, which is what callkeep reports.
  @SuppressWarnings("deprecation")
  @ReactMethod
  public void getCallAudioState(String uuid, Promise promise) {
    Connection connection = IncomingCallNotificationModule.connectionFor(uuid);
    CallAudioState state = connection != null ? connection.getCallAudioState() : null;
    if (state == null) {
      promise.resolve(null);
      return;
    }
    WritableMap result = Arguments.createMap();
    result.putString("route", CallAudioState.audioRouteToString(state.getRoute()));
    WritableArray available = Arguments.createArray();
    for (int route : ROUTES) {
      if ((state.getSupportedRouteMask() & route) == route) {
        available.pushString(CallAudioState.audioRouteToString(route));
      }
    }
    result.putArray("available", available);
    result.putString("bluetoothName", bluetoothName(state));
    promise.resolve(result);
  }

  /** The active Bluetooth device's name; null without one, before API 28, or without BLUETOOTH_CONNECT. */
  @SuppressLint("MissingPermission")
  @Nullable
  private static String bluetoothName(CallAudioState state) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
      return null;
    }
    BluetoothDevice device = state.getActiveBluetoothDevice();
    if (device == null) {
      return null;
    }
    try {
      return device.getName();
    } catch (SecurityException error) {
      return null;
    }
  }
}
