package com.signalwire.devicetests;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.os.SystemClock;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.UiObject2;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** A2 to A4: one call at a time, outbound and inbound. */
@RunWith(AndroidJUnit4.class)
public class CallTest extends SwBase {
  /** A2: outbound, Telecom ACTIVE, audio both ways, speaker on and off, the proximity lock follows the route, End. */
  @Test
  public void a2Outbound() throws Exception {
    openHome();
    dial(dest);
    needStatus("Connected", CONNECT_MS);
    String a = waitCalls(1, 10_000).get(0);
    List<String> telecom = telecomStates();
    assertTrue("Telecom lists the call ACTIVE: " + telecom, telecom.contains("ACTIVE"));
    assertSending(a, "connected");

    // Routes: the label follows the speaker button (the emulator has no earpiece).
    UiObject2 route = need(By.res("sw-route"), 5_000, "the route button");
    String before = textOf(route);
    route.click();
    SystemClock.sleep(2_500);
    String on = textOf(need(By.res("sw-route"), 5_000, "the route button"));
    need(By.res("sw-route"), 5_000, "the route button").click();
    SystemClock.sleep(2_500);
    String off = textOf(need(By.res("sw-route"), 5_000, "the route button"));
    mark("ROUTE before=" + before + " speaker-on=" + on + " speaker-off=" + off);
    shot("routes");
    assertTrue("speaker on reads Speaker: " + on, on.toLowerCase().contains("speaker"));
    assertSending(a, "after-routes");

    // The screen at the ear: the proximity lock on the receiver only. The
    // emulator offers only the speaker, so there it checks the lock is not
    // held and the display stays on with the sensor covered.
    assertProximityFollowsRoute(off, "after-routes");

    tap("sw-hangup", 5_000);
    needHome(10_000);
    JSONObject newest = new JSONObject(http("/newest"));
    double s = waitRestEnded(newest.getString("id"), 10_000);
    assertTrue("the leg ended on the server after End", s >= 0);
    SystemClock.sleep(1_000);
    assertTrue("Telecom has no call left", telecomStates().isEmpty());
    assertFalse("no proximity lock after the call", proximityLockHeld());
  }

  /** A3: inbound with the app open: the sheet, its name, Answer, audio, End. */
  @Test
  public void a3InboundAnswer() throws Exception {
    openHome();
    String id = ringApp("Android Test");
    String text = sheetName();
    assertTrue("the sheet shows the caller as Android Test: " + text, text.contains("Android Test"));
    assertNotNull("Answer on the sheet", dev.findObject(By.res("sw-answer")));
    checkSheetInsets();
    shot("sheet");
    List<String> telecom = telecomStates();
    assertTrue("Telecom rings the call: " + telecom, telecom.contains("RINGING"));
    tap("sw-answer", 5_000);
    needStatus("Connected", CONNECT_MS);
    String b = waitCalls(1, 10_000).get(0);
    assertTrue("Telecom ACTIVE", telecomStates().contains("ACTIVE"));
    assertSending(b, "answered");
    tap("sw-hangup", 5_000);
    needHome(10_000);
    assertTrue("the caller's leg ended", waitRestEnded(id, 10_000) >= 0);
  }

  /** A3 (Decline) and the sheet over the About modal, with its insets. */
  @Test
  public void a3DeclineOverAbout() throws Exception {
    openHome();
    tap("about", 5_000);
    need(By.textStartsWith("Signed in as"), 5_000, "the About modal");
    String id = ringApp("rn-device-caller");
    sheetName();
    assertNotNull("About is still open under the sheet", dev.findObject(By.textStartsWith("Signed in as")));
    checkSheetInsets();
    shot("sheet-over-about");
    tap("sw-decline", 5_000);
    double s = waitRestEnded(id, 15_000);
    assertTrue("the declined leg ended", s >= 0);
    assertTrue("the sheet went", gone(By.res("sw-incoming-sheet"), 5_000));
    assertNotNull("About is still open after Decline", dev.findObject(By.textStartsWith("Signed in as")));
    need(By.text("Close"), 5_000, "About's Close").click();
    needHome(5_000);
  }

  /** A4: inbound with the app in the background: the heads-up's Answer. */
  @Test
  public void a4InboundBackground() throws Exception {
    openHome();
    dev.pressHome();
    SystemClock.sleep(1_500);
    String id = ringApp("rn-device-caller");
    UiObject2 answer = waitFor(sysButton("Answer"), 20_000);
    shot("heads-up");
    if (answer == null) {
      assertTrue("Answer in the shade", tapInShade("Answer", 10_000));
    } else {
      List<String> texts = screenTexts();
      mark("HEADS-UP texts=" + texts);
      for (String t : texts) {
        assertFalse("no _undef_ in the notification", t.contains("_undef_"));
        assertFalse("no sip: in the notification", t.toLowerCase().startsWith("sip:"));
      }
      answer.click();
      mark("TAP heads-up Answer");
    }
    if (waitFor(By.descStartsWith("Call status: "), 10_000) == null) {
      mark("the app did not come forward on Answer; opening it");
      launchApp();
    }
    needStatus("Connected", CONNECT_MS);
    String b = waitCalls(1, 10_000).get(0);
    assertSending(b, "answered-from-notification");
    tap("sw-hangup", 5_000);
    assertTrue("the caller's leg ended", waitRestEnded(id, 10_000) >= 0);
  }

  /**
   * Diagnostic, not part of the suite: answers n inbound calls from the sheet
   * (instrumentation argument n, default 4) and records which connected.
   */
  @Test
  public void inboundAnswerLoop() throws Exception {
    int n = Integer.parseInt(androidx.test.platform.app.InstrumentationRegistry.getArguments().getString("n", "4"));
    openHome();
    int ok = 0;
    for (int i = 0; i < n; i++) {
      String id = ringApp("rn-device-caller");
      need(By.res("sw-answer"), 20_000, "Answer").click();
      boolean connected = waitFor(By.desc("Call status: Connected"), 10_000) != null;
      mark("LOOP " + i + " connected=" + connected + " id=" + id);
      if (connected) {
        ok++;
        SystemClock.sleep(2_000);
        tap("sw-hangup", 5_000);
      } else {
        http("/end?id=" + id);
      }
      needHome(20_000);
      SystemClock.sleep(2_000);
    }
    mark("LOOP connected " + ok + "/" + n);
    assertTrue("every answer connected: " + ok + "/" + n, ok == n);
  }

  static String group(Pattern p, String s) {
    Matcher m = p.matcher(s);
    return m.find() ? m.group(1) : null;
  }
}
