package com.signalwire.reactnative;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

/**
 * A `microphone` foreground service for a call that is not in Telecom.
 *
 * From Android 14 an app in the background records silence unless a
 * foreground service of type `microphone` runs. A call in callkeep's
 * ConnectionService has one (`phoneCall|microphone`); a plain WebRTC call,
 * with the provider's `callKit` off, had none, so the lock screen or Home
 * muted the user mid-call. JavaScript starts this while a call is in
 * progress and stops it when none is (CallForegroundService.tsx).
 *
 * Only `microphone`: `phoneCall` needs MANAGE_OWN_CALLS or the dialer role,
 * which is what a Telecom call is, and `camera` needs a CAMERA grant an
 * audio-only app never asks for. Android refuses the whole start if any type
 * passed is not allowed.
 *
 * Started with a plain startService() while the app is in the foreground, and
 * promoted here. Android refuses the promotion without the RECORD_AUDIO grant
 * or from the background; that is logged, and the next start (the module is
 * asked again as the call moves on) tries again. startForegroundService()
 * would turn such a refusal into a crash of the app.
 */
public class CallForegroundService extends Service {
  static final String TAG = "SignalWireCallService";
  static final String CHANNEL_ID = "signalwire-call-in-progress";
  static final int NOTIFICATION_ID = 0x5157;

  @Nullable
  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    try {
      int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
          ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
          : 0;
      ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(this), type);
    } catch (RuntimeException error) {
      // SecurityException (no RECORD_AUDIO, or not allowed while in the
      // background), ForegroundServiceStartNotAllowedException (12+).
      Log.w(TAG, "Could not run the call as a microphone foreground service; "
          + "Android may silence the microphone while the app is in the background: " + error);
      stopSelf(startId);
    }
    // A call does not outlive the process: nothing to restart.
    return START_NOT_STICKY;
  }

  @Override
  public void onDestroy() {
    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
    super.onDestroy();
  }

  private static Notification notification(Context context) {
    ensureChannel(context);
    ApplicationInfo info = context.getApplicationInfo();
    CharSequence appName = context.getPackageManager().getApplicationLabel(info);
    return new NotificationCompat.Builder(context, CHANNEL_ID)
        .setSmallIcon(info.icon != 0 ? info.icon : android.R.drawable.stat_sys_phone_call)
        .setContentTitle(appName)
        .setContentText("Call in progress")
        .setCategory(NotificationCompat.CATEGORY_CALL)
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .setOngoing(true)
        .setShowWhen(true)
        .setUsesChronometer(true)
        .setContentIntent(openApp(context))
        .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
        .build();
  }

  @Nullable
  private static PendingIntent openApp(Context context) {
    Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
    if (launch == null) {
      return null;
    }
    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    return PendingIntent.getActivity(
        context, NOTIFICATION_ID, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
  }

  private static void ensureChannel(Context context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      return;
    }
    NotificationManager manager = context.getSystemService(NotificationManager.class);
    if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) {
      return;
    }
    NotificationChannel channel =
        new NotificationChannel(CHANNEL_ID, "Calls in progress", NotificationManager.IMPORTANCE_LOW);
    channel.setShowBadge(false);
    manager.createNotificationChannel(channel);
  }
}
