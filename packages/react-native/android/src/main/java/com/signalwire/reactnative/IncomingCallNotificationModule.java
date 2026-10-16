package com.signalwire.reactnative;

import android.app.Activity;
import android.app.Application;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.os.Build;
import android.os.Bundle;
import android.telecom.Connection;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.Person;

import com.facebook.react.bridge.ActivityEventListener;
import com.facebook.react.bridge.LifecycleEventListener;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;

import java.lang.ref.WeakReference;
import java.lang.reflect.Method;

/**
 * The incoming-call notification a self-managed ConnectionService must post.
 *
 * With a self-managed PhoneAccount, Telecom draws no call UI. When a ringing
 * call may be shown, it calls Connection.onShowIncomingCallUi(), which
 * react-native-callkeep forwards to JavaScript as `showIncomingCallUi`, and
 * the app is expected to post a high-priority call notification with a
 * full-screen intent (Android's "Build a calling app" guide). Without one, a
 * call to a backgrounded or killed app rings nowhere: the package used to
 * start the activity from the push's headless task instead, which Android 10+
 * refuses as a background activity start.
 *
 * Answer opens the app and answers the call through the ConnectionService, as
 * Telecom's own answer would (callkeep then reports it to JavaScript as
 * `answerCall`); Decline rejects it the same way. The connection is looked up
 * through callkeep's VoiceConnectionService by reflection, so this library
 * builds without callkeep, which is an optional peer.
 */
public class IncomingCallNotificationModule extends ReactContextBaseJavaModule
    implements LifecycleEventListener, ActivityEventListener {
  static final String NAME = "SignalWireIncomingCall";
  static final String TAG = "SignalWireIncomingCall";
  static final String CHANNEL_ID = "signalwire-incoming-calls";
  static final String EXTRA_CALL_UUID = "com.signalwire.reactnative.CALL_UUID";
  static final String EXTRA_ACTION = "com.signalwire.reactnative.CALL_ACTION";
  static final String ACTION_SHOW = "show";
  static final String ACTION_ANSWER = "answer";
  static final String ACTION_DECLINE = "decline";

  /**
   * Whether the app's activities may show over the lock screen: from the first
   * ringing notification until JavaScript says no call is left (release()).
   * Static because the activity callbacks outlive any one React context.
   */
  private static volatile boolean holdLockScreen = false;
  private static WeakReference<Activity> lastActivity = new WeakReference<>(null);
  private static boolean callbacksRegistered = false;

  IncomingCallNotificationModule(ReactApplicationContext context) {
    super(context);
    context.addLifecycleEventListener(this);
    context.addActivityEventListener(this);
    Context app = context.getApplicationContext();
    synchronized (IncomingCallNotificationModule.class) {
      if (!callbacksRegistered && app instanceof Application) {
        ((Application) app).registerActivityLifecycleCallbacks(new TrackActivities());
        callbacksRegistered = true;
      }
    }
    Activity current = context.getCurrentActivity();
    if (current != null) {
      lastActivity = new WeakReference<>(current);
    }
  }

  /**
   * Applies the lock-screen hold to every activity as it is created.
   *
   * The full-screen intent targets the launcher activity, which is normally
   * singleTask and whose task outlives the process. Starting it behind the
   * keyguard either recreates it from the task's original intent or queues
   * the call intent as a new intent that is delivered only on resume, which
   * an activity behind the keyguard never reaches. So whether it may show
   * over the lock screen cannot be read off the intent; it is decided by
   * whether a call is ringing or in progress.
   */
  private static final class TrackActivities implements Application.ActivityLifecycleCallbacks {
    @Override
    public void onActivityCreated(@NonNull Activity activity, @Nullable Bundle state) {
      lastActivity = new WeakReference<>(activity);
      applyLockScreen(activity, holdLockScreen);
    }

    @Override
    public void onActivityStarted(@NonNull Activity activity) {}

    @Override
    public void onActivityResumed(@NonNull Activity activity) {
      lastActivity = new WeakReference<>(activity);
    }

    @Override
    public void onActivityPaused(@NonNull Activity activity) {}

    @Override
    public void onActivityStopped(@NonNull Activity activity) {}

    @Override
    public void onActivitySaveInstanceState(@NonNull Activity activity, @NonNull Bundle state) {}

    @Override
    public void onActivityDestroyed(@NonNull Activity activity) {}
  }

  private static void applyLockScreen(@Nullable Activity activity, boolean show) {
    if (activity == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.O_MR1) {
      return;
    }
    activity.runOnUiThread(() -> {
      activity.setShowWhenLocked(show);
      activity.setTurnScreenOn(show);
    });
  }

  @NonNull
  @Override
  public String getName() {
    return NAME;
  }

  /** Posts (or replaces) the ringing notification for one call. */
  @ReactMethod
  public void show(String uuid, String handle, String name, boolean hasVideo, String channelName, Promise promise) {
    try {
      Context context = getReactApplicationContext();
      ensureChannel(context, channelName);

      String title = name != null && !name.isEmpty() ? name : handle;
      Person caller = new Person.Builder().setName(title != null ? title : "Unknown caller").setImportant(true).build();
      PendingIntent show = activityIntent(context, uuid, ACTION_SHOW);
      PendingIntent answer = activityIntent(context, uuid, ACTION_ANSWER);
      PendingIntent decline = IncomingCallActionReceiver.pendingIntent(context, uuid);

      NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
          .setSmallIcon(smallIcon(context))
          .setContentTitle(title)
          .setContentText(hasVideo ? "Incoming video call" : "Incoming call")
          .setCategory(NotificationCompat.CATEGORY_CALL)
          .setPriority(NotificationCompat.PRIORITY_MAX)
          .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
          .setOngoing(true)
          .setAutoCancel(false)
          .setContentIntent(show)
          .setFullScreenIntent(show, true)
          .setStyle(NotificationCompat.CallStyle.forIncomingCall(caller, decline, answer).setIsVideo(hasVideo));

      // Before the full-screen intent starts the activity: see TrackActivities.
      holdLockScreen = true;
      applyLockScreen(lastActivity.get(), true);

      Notification notification = builder.build();
      // Rings until it is answered, declined or withdrawn.
      notification.flags |= Notification.FLAG_INSISTENT;
      NotificationManagerCompat.from(context).notify(uuid, NOTIFICATION_ID, notification);
      Log.d(TAG, "Showing incoming call " + uuid + " (full-screen allowed: " + canUseFullScreenIntent(context) + ")");
      promise.resolve(true);
    } catch (SecurityException error) {
      // POST_NOTIFICATIONS was refused (Android 13+).
      Log.w(TAG, "Cannot post the incoming-call notification: " + error);
      promise.resolve(false);
    } catch (Exception error) {
      Log.w(TAG, "Incoming-call notification failed: " + error);
      promise.reject("E_INCOMING_CALL_NOTIFICATION", error);
    }
  }

  /** Withdraws the call's notification. An answered call stays over the lock screen. */
  @ReactMethod
  public void cancel(String uuid) {
    NotificationManagerCompat.from(getReactApplicationContext()).cancel(uuid, NOTIFICATION_ID);
  }

  /** No call is left: the app no longer shows over the lock screen. */
  @ReactMethod
  public void release() {
    if (!holdLockScreen) {
      return;
    }
    holdLockScreen = false;
    applyLockScreen(lastActivity.get(), false);
  }

  /** Whether Android lets this app open a call over the lock screen (Android 14+ asks the user). */
  @ReactMethod
  public void canUseFullScreenIntent(Promise promise) {
    promise.resolve(canUseFullScreenIntent(getReactApplicationContext()));
  }

  // ------------------------------------------------------------ activity

  @Override
  public void onHostResume() {
    Activity activity = getCurrentActivity();
    if (activity != null) {
      handleIntent(activity, activity.getIntent());
    }
  }

  @Override
  public void onNewIntent(Intent intent) {
    Activity activity = getCurrentActivity();
    if (activity != null) {
      // singleTask: a tap while the activity exists arrives here, on resume.
      handleIntent(activity, intent);
    }
  }

  @Override
  public void onHostPause() {}

  @Override
  public void onHostDestroy() {}

  @Override
  public void onActivityResult(Activity activity, int requestCode, int resultCode, @Nullable Intent data) {}

  /** Acts on a tap on the notification or its Answer button, once. */
  private static void handleIntent(Activity activity, @Nullable Intent intent) {
    if (intent == null || !intent.hasExtra(EXTRA_CALL_UUID)) {
      return;
    }
    String uuid = intent.getStringExtra(EXTRA_CALL_UUID);
    String action = intent.getStringExtra(EXTRA_ACTION);
    Log.d(TAG, "Opened from the notification for " + uuid + " (" + action + ")");
    intent.removeExtra(EXTRA_CALL_UUID);
    intent.removeExtra(EXTRA_ACTION);
    if (ACTION_ANSWER.equals(action)) {
      Log.d(TAG, "Answer tapped for " + uuid);
      NotificationManagerCompat.from(activity).cancel(uuid, NOTIFICATION_ID);
      Connection connection = connectionFor(uuid);
      if (connection != null) {
        connection.onAnswer();
      }
    }
  }

  // ------------------------------------------------------------ helpers

  static final int NOTIFICATION_ID = 0x5157;

  /** The ringing call's Telecom connection, from callkeep's ConnectionService. */
  @Nullable
  static Connection connectionFor(String uuid) {
    try {
      Class<?> service = Class.forName("io.wazo.callkeep.VoiceConnectionService");
      Method getConnection = service.getMethod("getConnection", String.class);
      Object connection = getConnection.invoke(null, uuid);
      if (connection instanceof Connection) {
        return (Connection) connection;
      }
      Log.w(TAG, "No connection for " + uuid);
    } catch (Exception error) {
      Log.w(TAG, "react-native-callkeep's VoiceConnectionService is unavailable: " + error);
    }
    return null;
  }

  private static PendingIntent activityIntent(Context context, String uuid, String action) {
    Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
    Intent intent = launch != null ? launch : new Intent();
    intent.setPackage(context.getPackageName());
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    intent.putExtra(EXTRA_CALL_UUID, uuid);
    intent.putExtra(EXTRA_ACTION, action);
    return PendingIntent.getActivity(
        context,
        (uuid + action).hashCode(),
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
  }

  private static void ensureChannel(Context context, String channelName) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      return;
    }
    NotificationManager manager = context.getSystemService(NotificationManager.class);
    if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) {
      return;
    }
    NotificationChannel channel = new NotificationChannel(
        CHANNEL_ID,
        channelName != null && !channelName.isEmpty() ? channelName : "Incoming calls",
        NotificationManager.IMPORTANCE_HIGH);
    // A self-managed call has no system ringer: this channel is it.
    channel.setSound(
        RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
        new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build());
    channel.enableVibration(true);
    channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
    manager.createNotificationChannel(channel);
  }

  private static int smallIcon(Context context) {
    int icon = context.getApplicationInfo().icon;
    return icon != 0 ? icon : android.R.drawable.sym_call_incoming;
  }

  private static boolean canUseFullScreenIntent(Context context) {
    if (Build.VERSION.SDK_INT < 34) {
      return true;
    }
    NotificationManager manager = context.getSystemService(NotificationManager.class);
    return manager != null && manager.canUseFullScreenIntent();
  }
}
