package com.signalwire.reactnative;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.telecom.Connection;
import android.util.Log;

import androidx.core.app.NotificationManagerCompat;

/**
 * The incoming-call notification's Decline button.
 *
 * Rejects the call through its Telecom connection, exactly as a decline from
 * Telecom would; react-native-callkeep reports that to JavaScript as
 * `endCall`, so the package's registry turns the call down as usual. No
 * activity is opened.
 */
public class IncomingCallActionReceiver extends BroadcastReceiver {
  static final String ACTION_DECLINE = "com.signalwire.reactnative.DECLINE_CALL";

  static PendingIntent pendingIntent(Context context, String uuid) {
    Intent intent = new Intent(context, IncomingCallActionReceiver.class);
    intent.setAction(ACTION_DECLINE);
    intent.putExtra(IncomingCallNotificationModule.EXTRA_CALL_UUID, uuid);
    return PendingIntent.getBroadcast(
        context,
        (uuid + ACTION_DECLINE).hashCode(),
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
  }

  @Override
  public void onReceive(Context context, Intent intent) {
    if (!ACTION_DECLINE.equals(intent.getAction())) {
      return;
    }
    String uuid = intent.getStringExtra(IncomingCallNotificationModule.EXTRA_CALL_UUID);
    if (uuid == null) {
      return;
    }
    Log.d(IncomingCallNotificationModule.TAG, "Decline tapped for " + uuid);
    NotificationManagerCompat.from(context).cancel(uuid, IncomingCallNotificationModule.NOTIFICATION_ID);
    Connection connection = IncomingCallNotificationModule.connectionFor(uuid);
    if (connection != null) {
      connection.onReject();
    }
  }
}
