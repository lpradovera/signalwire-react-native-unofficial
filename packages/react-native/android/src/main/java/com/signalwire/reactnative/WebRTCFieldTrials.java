package com.signalwire.reactnative;

import android.util.Log;

import java.lang.reflect.Field;

/**
 * The libwebrtc field trial the package sets on react-native-webrtc.
 *
 * <p>libwebrtc's Android network monitor stops when the last ICE gathering
 * session stops and starts again with the next one, and until the platform's
 * network callbacks arrive again it knows no network. Its adapter check then
 * reports every interface as unavailable, so a session that starts in that
 * window gathers nothing ("Android network monitor found 0 networks", then
 * "Machine has no networks; no ports will be allocated") and reports gathering
 * complete. Answering an inbound call is such a start: the SDK, holding an
 * answer with no candidates, never sends it, and the caller rings until it
 * gives up. Disabling the adapter check lets the session use the interfaces
 * the system has (getifaddrs), whatever the monitor knows yet.
 *
 * <p>Set through reflection, so the package builds without react-native-webrtc
 * on its classpath and does nothing in an app without it. An app that sets
 * this trial itself keeps its own value; other trials it sets are kept.
 */
final class WebRTCFieldTrials {
  private static final String TAG = "SignalWireWebRTC";
  static final String ADAPTER_CHECK = "WebRTC-AndroidNetworkMonitor-IsAdapterAvailable/";
  static final String ADAPTER_CHECK_OFF = ADAPTER_CHECK + "Disabled/";

  private WebRTCFieldTrials() {}

  /** The trials string with the adapter check off, keeping everything else. */
  static String withAdapterCheckOff(String existing) {
    if (existing == null || existing.isEmpty()) {
      return ADAPTER_CHECK_OFF;
    }
    if (existing.startsWith(ADAPTER_CHECK) || existing.contains("/" + ADAPTER_CHECK)) {
      return existing;
    }
    return (existing.endsWith("/") ? existing : existing + "/") + ADAPTER_CHECK_OFF;
  }

  /**
   * Adds the trial to react-native-webrtc's WebRTCModuleOptions. Must run
   * before WebRTCModule is created: it passes the trials to
   * PeerConnectionFactory.initialize in its constructor.
   */
  static void apply() {
    try {
      Class<?> options = Class.forName("com.oney.WebRTCModule.WebRTCModuleOptions");
      Object instance = options.getMethod("getInstance").invoke(null);
      Field field = options.getField("fieldTrials");
      String before = (String) field.get(instance);
      String after = withAdapterCheckOff(before);
      if (!after.equals(before)) {
        field.set(instance, after);
        Log.i(TAG, "WebRTC field trials: " + after);
      }
    } catch (ClassNotFoundException absent) {
      // No react-native-webrtc in this app: nothing to configure.
    } catch (ReflectiveOperationException | RuntimeException e) {
      Log.w(TAG, "Could not set the WebRTC network-monitor field trial", e);
    }
  }
}
