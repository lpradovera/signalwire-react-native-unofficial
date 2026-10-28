package com.signalwire.devicetests;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.os.SystemClock;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.uiautomator.By;

import org.junit.Test;
import org.junit.runner.RunWith;

import java.util.List;

/** The opt-down call-waiting modes; each needs its own build (EXPO_PUBLIC_SW_CALL_WAITING). */
@RunWith(AndroidJUnit4.class)
public class ModeTest extends SwBase {
  private String callA() {
    openHome();
    dial(dest);
    needStatus("Connected", CONNECT_MS);
    String a = waitCalls(1, 10_000).get(0);
    assertSending(a, "A-connected");
    return a;
  }

  private void dialAgainRefused() {
    tap("dial-again", 5_000);
    need(By.textContains("CallInProgressError"), 10_000, "the CallInProgressError line");
    SystemClock.sleep(3_000);
    assertEquals("no second call placed", 1, calls().size());
    mark("DIAL-AGAIN refused with CallInProgressError");
  }

  /** 'endAndAccept': Dial again refused; the sheet offers Decline and End & Accept only. */
  @Test
  public void endAndAcceptMode() throws Exception {
    openHome();
    assertEquals("the build's mode", "endAndAccept", launchedMode());
    String a = callA();
    dialAgainRefused();

    String b = ringApp("rn-device-caller");
    sheetName();
    assertNotNull("End & Accept", dev.findObject(By.res("sw-end-accept")));
    assertNotNull("Decline", dev.findObject(By.res("sw-decline")));
    assertNull("no Hold & Accept in endAndAccept", dev.findObject(By.res("sw-hold-accept")));
    shot("sheet");
    tap("sw-decline", 5_000);
    assertTrue("the declined leg ended", waitRestEnded(b, 15_000) >= 0);
    assertSending(a, "A-after-decline");

    ringApp("rn-device-caller");
    sheetName();
    tap("sw-end-accept", 5_000);
    List<String> ids = waitCalls(2, 15_000);
    String c = ids.get(ids.size() - 1);
    needStatus("Connected", CONNECT_MS);
    SystemClock.sleep(2_000);
    assertSending(c, "C-after-end-accept");
    assertEquals("one call in Telecom", 1, telecomStates().size());
    tap("sw-hangup", 5_000);
    needHome(10_000);
  }

  /** 'single': Dial again refused; a second inbound call is busy and never shows. */
  @Test
  public void singleMode() throws Exception {
    openHome();
    assertEquals("the build's mode", "single", launchedMode());
    String a = callA();
    dialAgainRefused();
    String b = ringApp("rn-device-caller");
    boolean sheet = waitFor(By.res("sw-incoming-sheet"), 6_000) != null;
    double s = waitRestEnded(b, 15_000);
    mark("SECOND sheet=" + sheet + " ended-after=" + s);
    assertTrue("the second call never shows", !sheet);
    assertTrue("the second leg ended (busy)", s >= 0);
    List<String> telecom = telecomStates();
    assertEquals("Telecom: one call, ACTIVE: " + telecom, 1, telecom.size());
    assertTrue("Refusing inbound call ... as busy is logged", !logLines("Refusing inbound call").isEmpty());
    assertSending(a, "A-after-busy");
    tap("sw-hangup", 5_000);
    needHome(10_000);
  }
}
