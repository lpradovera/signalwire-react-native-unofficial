package com.signalwire.devicetests;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.os.SystemClock;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.UiObject2;

import org.junit.Test;
import org.junit.runner.RunWith;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/** A1: a fresh install (the host uninstalls and reinstalls before this test). */
@RunWith(AndroidJUnit4.class)
public class LaunchTest extends SwBase {
  @Test
  public void a1FreshInstall() {
    launchApp();
    List<String> prompts = new ArrayList<>();
    long start = SystemClock.uptimeMillis();
    while (SystemClock.uptimeMillis() - start < 30_000) {
      UiObject2 msg = waitFor(By.res("com.android.permissioncontroller:id/permission_message"), 4_000);
      if (msg == null) {
        if (dev.findObject(By.res("about")) != null) {
          break;
        }
        continue;
      }
      String text = msg.getText();
      prompts.add(text);
      mark("PROMPT " + text);
      UiObject2 allow = dev.findObject(By.res("com.android.permissioncontroller:id/permission_allow_foreground_only_button"));
      if (allow == null) {
        allow = dev.findObject(By.res("com.android.permissioncontroller:id/permission_allow_button"));
      }
      allow.click();
      SystemClock.sleep(800);
    }
    needHome(30_000);
    shot("home");
    // The warning can come after the prompts too (when the push token is
    // first watched): wait, then count.
    SystemClock.sleep(8_000);
    List<String> pushOff = logLines("Android push is off");
    List<String> ready = logLines("CallKit ready");
    mark("PUSH-OFF count=" + pushOff.size() + " PROMPTS=" + prompts + " READY=" + (ready.isEmpty() ? "-" : ready.get(0)));
    for (String p : prompts) {
      String l = p.toLowerCase(Locale.ROOT);
      assertTrue("a camera prompt on a voice-only build: " + p, !l.contains("camera") && !l.contains("take pictures"));
    }
    assertTrue("at least the microphone prompt", prompts.toString().toLowerCase(Locale.ROOT).contains("record audio"));
    assertEquals("one 'push is off' warning per run: " + pushOff, 1, pushOff.size());
    assertTrue("no Push registration skipped line", logLines("Push registration skipped").isEmpty());
  }
}
