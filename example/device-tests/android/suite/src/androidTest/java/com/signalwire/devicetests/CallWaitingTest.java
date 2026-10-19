package com.signalwire.devicetests;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.graphics.Rect;
import android.os.SystemClock;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.UiObject2;

import org.junit.Test;
import org.junit.runner.RunWith;

import java.util.List;

/**
 * Call waiting in the default 'full' mode. After every switch, each call's
 * audio is checked: the live one sends and receives, the held one neither.
 */
@RunWith(AndroidJUnit4.class)
public class CallWaitingTest extends SwBase {

  private String callA() {
    openHome();
    dial(dest);
    needStatus("Connected", CONNECT_MS);
    String a = waitCalls(1, 10_000).get(0);
    assertSending(a, "A-connected");
    return a;
  }

  /** Hold & Accept, Swap, Swap back, End the held call; the other carries on. */
  @Test
  public void cwHoldAcceptSwapEnd() throws Exception {
    String a = callA();
    assertEquals("the build's call-waiting mode", "full", launchedMode());
    ringApp("rn-device-caller");
    sheetName();
    assertNotNull("Hold & Accept", dev.findObject(By.res("sw-hold-accept")));
    assertNotNull("End & Accept", dev.findObject(By.res("sw-end-accept")));
    assertNotNull("Decline", dev.findObject(By.res("sw-decline")));
    checkSheetInsets();
    shot("waiting-sheet");
    tap("sw-hold-accept", 5_000);
    List<String> ids = waitCalls(2, 15_000);
    String b = ids.get(1);
    need(By.res("held-call"), 10_000, "the held-call row");
    SystemClock.sleep(1_000);
    assertSwitch(b, a, "after-hold-accept");
    List<String> telecom = telecomStates();
    assertTrue("Telecom: one ACTIVE, one held: " + telecom, telecom.contains("ACTIVE") && telecom.contains("ON_HOLD"));
    shot("held-row");

    tap("swap-call", 5_000);
    SystemClock.sleep(1_000);
    assertSwitch(a, b, "after-swap");
    tap("swap-call", 5_000);
    SystemClock.sleep(1_000);
    assertSwitch(b, a, "after-swap-back");

    tap("end-held-call", 5_000);
    assertTrue("the held row went", gone(By.res("held-call"), 10_000));
    assertSending(b, "B-after-ending-held-A");
    tap("sw-hangup", 5_000);
    needHome(10_000);
  }

  /**
   * Hold & Accept by a shell `input tap` at the centre of its two-line label
   * (Len's round 3: such a tap did nothing on a Pixel 6 Pro). Each of the
   * sheet's buttons is one node named by its label, the label lies inside its
   * button, and the tap holds A and answers B. Also: the proximity lock
   * follows A's route, and is gone once both calls end.
   */
  @Test
  public void cwHoldAcceptCentreTap() throws Exception {
    String a = callA();
    assertProximityFollowsRoute(textOf(need(By.res("sw-route"), 5_000, "the route button")), "A");
    ringApp("rn-device-caller");
    sheetName();
    String[][] buttons = {{"sw-decline", "Decline"}, {"sw-end-accept", "End & Accept"}, {"sw-hold-accept", "Hold & Accept"}};
    for (String[] b : buttons) {
      UiObject2 button = need(By.res(b[0]), 5_000, b[1]);
      assertEquals(b[1] + " is named by its label", b[1], button.getContentDescription());
      assertTrue(b[1] + " is the clickable node", button.isClickable());
      Rect outer = button.getVisibleBounds();
      for (UiObject2 child : button.getChildren()) {
        assertTrue(b[1] + ": its label lies inside it", outer.contains(child.getVisibleBounds()));
        assertFalse(b[1] + ": its label is not a clickable node of its own", child.isClickable());
      }
    }
    UiObject2 hold = need(By.res("sw-hold-accept"), 5_000, "Hold & Accept");
    List<UiObject2> label = hold.getChildren();
    Rect target = (label.isEmpty() ? hold : label.get(0)).getVisibleBounds();
    shot("centre-tap-sheet");
    sh("input tap " + target.centerX() + " " + target.centerY());
    mark("INPUT TAP Hold & Accept label centre " + target.centerX() + "," + target.centerY()
        + " label=" + target.toShortString() + " button=" + hold.getVisibleBounds().toShortString());
    List<String> ids = waitCalls(2, 15_000);
    String b = ids.get(1);
    need(By.res("held-call"), 10_000, "the held-call row");
    SystemClock.sleep(1_000);
    assertSwitch(b, a, "after-centre-tap");
    List<String> telecom = telecomStates();
    assertTrue("Telecom: one ACTIVE, one held: " + telecom, telecom.contains("ACTIVE") && telecom.contains("ON_HOLD"));

    tap("end-held-call", 5_000);
    assertTrue("the held row went", gone(By.res("held-call"), 10_000));
    tap("sw-hangup", 5_000);
    needHome(10_000);
    SystemClock.sleep(1_000);
    assertFalse("no proximity lock after both calls", proximityLockHeld());
  }

  /** Decline while a call is up, then End & Accept: the first call ends, the third connects. */
  @Test
  public void cwDeclineThenEndAccept() throws Exception {
    String a = callA();
    String c = ringApp("rn-device-caller");
    sheetName();
    tap("sw-decline", 5_000);
    double s = waitRestEnded(c, 15_000);
    assertTrue("the declined leg ended", s >= 0);
    assertTrue("the sheet went", gone(By.res("sw-incoming-sheet"), 5_000));
    assertNull("nothing held after Decline", dev.findObject(By.res("held-call")));
    assertSending(a, "A-after-decline");

    ringApp("rn-device-caller");
    sheetName();
    tap("sw-end-accept", 5_000);
    List<String> ids = waitCalls(2, 15_000);
    String d = ids.get(ids.size() - 1);
    needStatus("Connected", CONNECT_MS);
    SystemClock.sleep(2_000);
    assertNull("no held call after End & Accept", dev.findObject(By.res("held-call")));
    assertSending(d, "D-after-end-accept");
    List<String> telecom = telecomStates();
    assertEquals("Telecom: only the accepted call: " + telecom, 1, telecom.size());
    tap("sw-hangup", 5_000);
    needHome(10_000);
  }

  /** Dial again holds the first call; a third call is busy; Swap; End; Resume. */
  @Test
  public void cwDialAgainThirdBusy() throws Exception {
    String a = callA();
    tap("dial-again", 5_000);
    List<String> ids = waitCalls(2, 15_000);
    String b = ids.get(1);
    need(By.res("held-call"), 15_000, "the held-call row");
    needStatus("Connected", CONNECT_MS);
    SystemClock.sleep(1_000);
    assertSwitch(b, a, "after-dial-again");

    String c = ringApp("rn-device-caller");
    boolean sheet = waitFor(By.res("sw-incoming-sheet"), 6_000) != null;
    double busy = waitRestEnded(c, 15_000);
    mark("THIRD sheet=" + sheet + " ended-after=" + busy);
    assertTrue("a third call never rings", !sheet);
    assertTrue("a third call's leg ends (busy)", busy >= 0);
    assertTrue("Refusing the third call is logged", !logLines("Refusing inbound call").isEmpty());

    tap("swap-call", 5_000);
    SystemClock.sleep(1_000);
    assertSwitch(a, b, "after-swap");
    tap("sw-hangup", 5_000);
    // B is left, held: Resume it.
    tap("resume-call", 10_000);
    SystemClock.sleep(1_000);
    assertSending(b, "B-after-resume");
    tap("sw-hangup", 5_000);
    needHome(10_000);
  }
}
