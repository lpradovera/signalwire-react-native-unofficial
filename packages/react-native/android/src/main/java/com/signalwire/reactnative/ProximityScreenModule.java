package com.signalwire.reactnative;

import android.content.Context;
import android.os.PowerManager;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;

/**
 * Blanks the screen at the ear during a call on the receiver, the way the
 * system dialer does: a PROXIMITY_SCREEN_OFF_WAKE_LOCK held while the call's
 * route is the earpiece. While it is held, the system's display power
 * controller watches the proximity sensor itself and turns the screen off
 * when something is near and back on when it goes away; the app never reads
 * the sensor.
 *
 * A self-managed Telecom call has no system in-call UI to do this. The
 * package used to blank the screen only once JavaScript had seen a "near"
 * event from react-native-incall-manager's sensor listener and asked for
 * the lock, so the screen stayed on whenever that event did not arrive.
 *
 * JavaScript says when to hold the lock (see telecomAudioRoutes'
 * startTelecomCallScreen): the route is the receiver. It is released on any
 * other route, at once, and when the call ends, then only once the phone
 * has left the ear (RELEASE_FLAG_WAIT_FOR_NO_PROXIMITY), so the screen
 * doesn't light up against the cheek.
 */
public class ProximityScreenModule extends ReactContextBaseJavaModule {
  static final String NAME = "SignalWireProximityScreen";
  private static final String TAG = "SignalWireProximity";

  /** Null where the device has no proximity screen-off (no sensor: a tablet). */
  @Nullable private final PowerManager.WakeLock lock;

  ProximityScreenModule(ReactApplicationContext context) {
    super(context);
    lock = newLock(context);
  }

  @NonNull
  @Override
  public String getName() {
    return NAME;
  }

  @Nullable
  private static PowerManager.WakeLock newLock(Context context) {
    PowerManager power = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
    if (power == null || !power.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) {
      return null;
    }
    PowerManager.WakeLock created =
        power.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "SignalWire:proximity");
    // One holder, so a second acquire is a no-op and one release ends it.
    created.setReferenceCounted(false);
    return created;
  }

  /**
   * Holds the lock (`hold`), or releases it. `waitForFar`: on release, the
   * screen comes back once nothing is near the sensor rather than at once.
   */
  @ReactMethod
  public void setHeld(boolean hold, boolean waitForFar) {
    apply(hold, waitForFar);
  }

  private synchronized void apply(boolean hold, boolean waitForFar) {
    if (lock == null) {
      return;
    }
    try {
      if (hold && !lock.isHeld()) {
        Log.d(TAG, "holding the proximity screen-off lock");
        lock.acquire();
      } else if (!hold && lock.isHeld()) {
        Log.d(TAG, "releasing the proximity screen-off lock" + (waitForFar ? " once far" : ""));
        lock.release(waitForFar ? PowerManager.RELEASE_FLAG_WAIT_FOR_NO_PROXIMITY : 0);
      }
    } catch (RuntimeException error) {
      // A missing WAKE_LOCK permission, say: the call goes on with the screen on.
      Log.w(TAG, "proximity screen-off lock failed", error);
    }
  }

  /** The app's React instance is going away: never leave the screen blanked. */
  @Override
  public void invalidate() {
    apply(false, false);
    super.invalidate();
  }
}
