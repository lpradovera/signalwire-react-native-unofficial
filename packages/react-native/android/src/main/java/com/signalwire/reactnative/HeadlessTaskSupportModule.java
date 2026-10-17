package com.signalwire.reactnative;

import android.util.Log;

import androidx.annotation.NonNull;

import com.facebook.fbreact.specs.NativeHeadlessJsTaskSupportSpec;
import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.jstasks.HeadlessJsTaskContext;
import com.facebook.react.module.annotations.ReactModule;

import java.util.Collections;
import java.util.List;

/**
 * Lets a headless JS task tell native it has finished, under the New
 * Architecture.
 *
 * React Native's bridgeless runtime (CoreReactPackage, 0.81) does not
 * register the HeadlessJsTaskSupport module that the bridge's
 * CoreModulesPackage does, so AppRegistry.startHeadlessTask finds no
 * NativeHeadlessJsTaskSupport and never reports a finished task. Each task
 * then runs until its timeout: 60 s for React Native Firebase's messaging
 * task. Its service is started with START_REDELIVER_INTENT for that whole
 * minute, so if the process dies meanwhile, Android restarts the service and
 * redelivers the FCM message: a call that was already answered or declined
 * rings again, and answering it dials a spent bridge token (emulator,
 * 2026-10-17, real FCM: "Scheduling restart of crashed service
 * ReactNativeFirebaseMessagingHeadlessService", then a second incoming call
 * with the previous push's token).
 *
 * This is the bridge module's behaviour, under the same name. It is added
 * only for a bridgeless context, where the name is otherwise unclaimed.
 */
@ReactModule(name = NativeHeadlessJsTaskSupportSpec.NAME)
public class HeadlessTaskSupportModule extends NativeHeadlessJsTaskSupportSpec {
  private static final String TAG = "SignalWireHeadlessTask";

  public HeadlessTaskSupportModule(ReactApplicationContext context) {
    super(context);
  }

  /** The module for a context that lacks React Native's own: bridgeless only. */
  @NonNull
  static List<NativeModule> forContext(@NonNull ReactApplicationContext context) {
    return context.isBridgeless()
        ? Collections.<NativeModule>singletonList(new HeadlessTaskSupportModule(context))
        : Collections.<NativeModule>emptyList();
  }

  @Override
  public void notifyTaskFinished(double taskIdDouble) {
    int taskId = (int) taskIdDouble;
    HeadlessJsTaskContext tasks = HeadlessJsTaskContext.getInstance(getReactApplicationContext());
    if (tasks.isTaskRunning(taskId)) {
      tasks.finishTask(taskId);
    } else {
      Log.w(TAG, "Tried to finish non-active task " + taskId + "; did it time out?");
    }
  }

  @Override
  public void notifyTaskRetry(double taskIdDouble, Promise promise) {
    int taskId = (int) taskIdDouble;
    HeadlessJsTaskContext tasks = HeadlessJsTaskContext.getInstance(getReactApplicationContext());
    promise.resolve(tasks.isTaskRunning(taskId) && tasks.retryTask(taskId));
  }
}
