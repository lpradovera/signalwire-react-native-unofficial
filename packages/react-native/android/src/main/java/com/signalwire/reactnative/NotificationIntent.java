package com.signalwire.reactnative;

import android.content.Intent;
import android.util.Log;

import androidx.annotation.Nullable;

/**
 * The ringing notification's activity intents: a tap on the notification
 * ("show") or on its Answer ("answer"), each naming the call. Kept apart from
 * the module so the decision can be tested without Android.
 */
final class NotificationIntent {
  static final String EXTRA_CALL_UUID = "com.signalwire.reactnative.CALL_UUID";
  static final String EXTRA_ACTION = "com.signalwire.reactnative.CALL_ACTION";
  static final String ACTION_SHOW = "show";
  static final String ACTION_ANSWER = "answer";
  /** The module's log tag, so both lines read together in logcat. */
  private static final String TAG = "SignalWireIncomingCall";

  /** What an Answer does: cancel the notification and answer the Telecom call. */
  interface Actions {
    void answer(String uuid);
  }

  private NotificationIntent() {}

  /**
   * Acts on a notification intent once: the call extras are removed, so the
   * same intent seen again (a new intent, then the resume) does nothing.
   * Returns whether the intent named a call.
   */
  static boolean handle(@Nullable Intent intent, String source, Actions actions) {
    if (intent == null || !intent.hasExtra(EXTRA_CALL_UUID)) {
      return false;
    }
    String uuid = intent.getStringExtra(EXTRA_CALL_UUID);
    String action = intent.getStringExtra(EXTRA_ACTION);
    Log.d(TAG, "Opened from the notification for " + uuid + " (" + action + ", " + source + ")");
    intent.removeExtra(EXTRA_CALL_UUID);
    intent.removeExtra(EXTRA_ACTION);
    if (ACTION_ANSWER.equals(action)) {
      Log.d(TAG, "Answer tapped for " + uuid);
      actions.answer(uuid);
    }
    return true;
  }
}
