package com.signalwire.devicetests;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.os.SystemClock;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.UiObject2;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

/** Back, the lock screen, and the microphone in the background. */
@RunWith(AndroidJUnit4.class)
public class BackgroundTest extends SwBase {
  private String callA() {
    openHome();
    dial(dest);
    needStatus("Connected", CONNECT_MS);
    String a = waitCalls(1, 10_000).get(0);
    assertSending(a, "A-connected");
    return a;
  }

  /** Presses Back until the app is no longer in front (the root screen's Back). */
  private void backOut() {
    for (int i = 0; i < 3; i++) {
      dev.pressBack();
      mark("BACK");
      SystemClock.sleep(1_500);
      if (!pkg.equals(dev.getCurrentPackageName())) {
        break;
      }
    }
    mark("FRONT " + dev.getCurrentPackageName());
  }

  /**
   * One call: locked 15 s (the microphone stays live), then Back keeps the
   * call (default) and the ongoing-call notification brings the screen back.
   */
  @Test
  public void lockThenBackKeepsCall() throws Exception {
    openHome();
    assertEquals("the build's mode", "full", launchedMode());
    String a = callA();
    String rest = new JSONObject(http("/newest")).getString("id");
    lockedSamples(a, "callkit");
    mark("FGS " + foregroundServices());
    backKept(a, rest);
    tap("sw-hangup", 5_000);
    assertTrue("the leg ended", waitRestEnded(rest, 10_000) >= 0);
    restBothWays(rest);
  }

  /** The server got about as many packets from the app as it sent to it. */
  private void restBothWays(String rest) throws Exception {
    long[] p = restPackets(rest);
    assertNotNull("REST packet counts for " + rest, p);
    assertTrue("REST: packets from the app " + p[0] + " vs to it " + p[1], p[0] >= 0.85 * p[1]);
  }

  private void backKept(String a, String rest) throws Exception {
    Stat before = latest(a);
    backOut();
    assertTrue("the app left the screen", !pkg.equals(dev.getCurrentPackageName()));
    SystemClock.sleep(4_000);
    assertEquals("the leg is still up", "answered", restCall(rest).optString("status"));
    assertTrue("Telecom still ACTIVE", telecomStates().contains("ACTIVE"));
    dev.openNotification();
    SystemClock.sleep(1_500);
    shot("shade-after-back");
    List<String> texts = screenTexts();
    mark("SHADE texts=" + texts);
    // The ongoing-call notification: tap its body (the app's name or the call text).
    UiObject2 n = waitFor(By.text(Pattern.compile("(?i).*(call in progress|ongoing call|signalwire rn example|rn-device-test|rn device test).*")), 5_000);
    assertNotNull("the ongoing-call notification", n);
    mark("SHADE TAP " + n.getText());
    n.click();
    need(By.res("sw-hangup"), 15_000, "the call screen back from the notification");
    double[] r = rateAcross(a, before, "while-closed");
    assertTrue("audio both ways while the app was closed: " + r[0] + "/" + r[1], r[0] >= 20 && r[1] >= 20);
    assertSending(a, "after-notification");
  }

  /** endCallsOnHostDestroy: Back ends the call and the server leg ends within seconds. */
  @Test
  public void backEndsCall() throws Exception {
    openHome();
    assertEquals("the build's mode", "full+endOnBack", launchedMode());
    callA();
    String rest = new JSONObject(http("/newest")).getString("id");
    backOut();
    double s = waitRestEnded(rest, 15_000);
    mark("BACK-END leg ended after " + s + " s");
    assertTrue("the leg ended after Back", s >= 0);
    assertTrue("within 5 s", s <= 5.0);
    SystemClock.sleep(1_000);
    assertTrue("Telecom has no call", telecomStates().isEmpty());
    assertTrue("no RPCTimeoutError", logLines("RPCTimeoutError").isEmpty());
    openHome();
    assertTrue("no leftover call screen", dev.findObject(By.res("sw-hangup")) == null);
  }

  /** Without CallKit (EXPO_PUBLIC_SW_CALLKIT=0): the microphone service keeps the mic live when locked. */
  @Test
  public void lockedMicWithoutCallKit() throws Exception {
    String a = callA();
    String rest = new JSONObject(http("/newest")).getString("id");
    String fgs = foregroundServices();
    mark("FGS during call " + fgs);
    assertTrue("CallForegroundService runs in the foreground: " + fgs,
        fgs.contains("CallForegroundService") && fgs.contains("isForeground=true"));
    lockedSamples(a, "no-callkit");
    tap("sw-hangup", 5_000);
    needHome(10_000);
    SystemClock.sleep(2_000);
    String after = foregroundServices();
    mark("FGS after hangup " + after);
    assertTrue("the service stops with the call: " + after, !after.contains("CallForegroundService"));
    restBothWays(rest);
  }

  /** 15 s locked: samples of AudioService's silenced flag and the RTP rate. */
  private void lockedSamples(String call, String label) {
    Stat first = latest(call);
    lockScreen();
    assertTrue("the screen is off", !isInteractive());
    List<String> silenced = new ArrayList<>();
    for (int i = 0; i < 5; i++) {
      SystemClock.sleep(3_000);
      silenced.add(recordingSilenced());
    }
    mark("LOCKED " + label + " 15s silenced=" + silenced + " fgs=" + foregroundServices());
    wake();
    double[] r = rateAcross(call, first, "locked-" + label);
    double in = r[0];
    double out = r[1];
    assertTrue("capture never silenced while locked: " + silenced, !silenced.contains("silenced:true"));
    assertTrue("capture seen while locked: " + silenced, silenced.contains("silenced:false"));
    assertTrue("packets out while locked: " + out, out >= 20);
    assertTrue("packets in while locked: " + in, in >= 20);
    assertSending(call, "after-unlock");
  }

  /** An incoming call while locked: answer from the lock screen (full-screen intent, else the notification). */
  @Test
  public void answerOnLockScreen() throws Exception {
    openHome();
    lockScreen();
    String id = ringApp("rn-device-caller");
    // The full-screen intent shows the app (its sheet) over the keyguard;
    // otherwise the call notification's Answer.
    UiObject2 sheetAnswer = waitFor(By.res("sw-answer"), 15_000);
    shot("locked-ringing");
    mark("LOCKSCREEN interactive=" + isInteractive() + " sheet=" + (sheetAnswer != null) + " front=" + dev.getCurrentPackageName());
    if (sheetAnswer != null) {
      sheetAnswer.click();
      mark("TAP sw-answer over the lock screen");
    } else {
      UiObject2 answer = waitFor(sysButton("Answer"), 5_000);
      assertNotNull("an Answer on the lock screen", answer);
      answer.click();
      mark("TAP notification Answer on the lock screen");
    }
    needStatus("Connected", CONNECT_MS);
    String b = waitCalls(1, 10_000).get(0);
    mark("LOCKSCREEN keyguard after answer: " + sh("dumpsys window").contains("mDreamingLockscreen=true"));
    assertSending(b, "answered-locked");
    tap("sw-hangup", 5_000);
    assertTrue("the caller's leg ended", waitRestEnded(id, 10_000) >= 0);
  }

}
