package com.signalwire.devicetests;

import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.os.SystemClock;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.UiObject2;

import org.json.JSONArray;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.util.List;
import java.util.regex.Pattern;

/** Token renewal and refusal, the reconnect banner, and a pushed call. */
@RunWith(AndroidJUnit4.class)
public class ConnectionTest extends SwBase {
  /**
   * Token renewal on the push path (the push build, TOKEN_TTL_SECONDS=120):
   * a renewal while open; 190 s in the background (Android cuts a
   * background app's sockets, and the token expires); then the call arrives
   * as a push, as a backend sends it, and the answered call connects.
   */
  @Test
  public void tokenRenewalThenPush() throws Exception {
    openHome();
    mark("FOREGROUND 110 s");
    SystemClock.sleep(110_000);
    List<String> renewed = logLines("Token renewed");
    assertTrue("a renewal was logged in the foreground", !renewed.isEmpty());
    int before = new JSONArray(http("/tokenlog")).length();
    dev.pressHome();
    mark("BACKGROUND 190 s");
    SystemClock.sleep(190_000);
    mark("TOKEN requests while in the background=" + (new JSONArray(http("/tokenlog")).length() - before));
    mark("ALLOWLIST " + sh("cmd deviceidle tempwhitelist -d 20000 " + pkg).trim());
    String callId = "sim-" + System.currentTimeMillis();
    mark("PUSH " + sh("am broadcast -n " + pkg + "/" + pkg + ".harness.SimulatedFcmReceiver --es call_id " + callId
        + " --es sw_from +15550008888 --es from_name Hal --es bridgeToken tok-" + callId).trim());
    UiObject2 answer = waitFor(sysButton("Answer"), 20_000);
    assertNotNull("the pushed call rings", answer);
    answer = waitFor(sysButton("Answer"), 2_000);
    answer.click();
    mark("TAP heads-up Answer");
    needStatus("Connected", CONNECT_MS);
    String b = waitCalls(1, 15_000).get(0);
    assertSending(b, "push-after-background");
    mark("TOKEN requests in all=" + new JSONArray(http("/tokenlog")).length() + " renewed-lines=" + logLines("Token renewed").size());
    tap("sw-hangup", 5_000);
  }

  /** The token server answers 401: the app says so instead of retrying. */
  @Test
  public void tokenRefused401() throws Exception {
    try {
      http("/mode?token=refuse");
      forceStop();
      launchApp();
      UiObject2 e = need(By.textStartsWith("The token server refused this device"), 30_000, "the refusal message");
      mark("REFUSED text=" + e.getText());
      shot("refused");
      assertTrue("names the 401: " + e.getText(), e.getText().contains("401"));
    } finally {
      http("/mode?token=ok");
    }
    forceStop();
    openHome();
  }

  /** Cut the app's network, then restore it: the banner shows, then clears. */
  @Test
  public void reconnectBanner() throws Exception {
    openHome();
    sh("svc wifi disable");
    sh("svc data disable");
    mark("NETWORK off");
    long off = SystemClock.uptimeMillis();
    UiObject2 banner = null;
    while (SystemClock.uptimeMillis() - off < 60_000 && banner == null) {
      banner = dev.findObject(By.pkg(pkg).text(Pattern.compile("(?i).*(websocket|connection|error|connecting|reconnect|offline).*")));
      SystemClock.sleep(1_000);
    }
    String shown = banner == null ? null : banner.getText();
    mark("BANNER after " + (SystemClock.uptimeMillis() - off) / 1000.0 + " s: " + shown);
    shot("network-off");
    sh("svc wifi enable");
    sh("svc data enable");
    mark("NETWORK on");
    long on = SystemClock.uptimeMillis();
    boolean cleared = false;
    while (SystemClock.uptimeMillis() - on < 60_000) {
      UiObject2 still = dev.findObject(By.pkg(pkg).text(Pattern.compile("(?i).*(websocket|connection error|error|connecting|reconnect|offline).*")));
      if (still == null && dev.findObject(By.res("about")) != null) {
        cleared = true;
        break;
      }
      SystemClock.sleep(1_000);
    }
    mark("BANNER cleared=" + cleared + " after " + (SystemClock.uptimeMillis() - on) / 1000.0 + " s");
    shot("network-on");
    assertNotNull("a banner while the network was off", shown);
    assertTrue("the banner clears and Home is back", cleared);
  }

  /**
   * A pushed call with the app killed: the simulated FCM receiver (the push
   * build only) delivers the data message, the call rings, Answer dials the
   * bridge address and the call connects.
   */
  @Test
  public void pushWakeAnswer() throws Exception {
    openHome();
    dev.pressHome();
    SystemClock.sleep(1_500);
    sh("am kill " + pkg);
    SystemClock.sleep(1_500);
    String pid = sh("pidof " + pkg).trim();
    mark("KILLED pid=[" + pid + "]");
    // What Google Play services grants a high-priority FCM delivery: a short
    // allowlist to start the messaging service from the background. A plain
    // broadcast gets none (BackgroundServiceStartNotAllowedException).
    mark("ALLOWLIST " + sh("cmd deviceidle tempwhitelist -d 20000 " + pkg).trim());
    String callId = "sim-" + System.currentTimeMillis();
    String r = sh("am broadcast -n " + pkg + "/" + pkg + ".harness.SimulatedFcmReceiver --es call_id " + callId
        + " --es sw_from +15550008888 --es from_name Hal --es bridgeToken tok-" + callId);
    mark("PUSH broadcast " + r.trim());
    UiObject2 answer = waitFor(sysButton("Answer"), 20_000);
    shot("push-ringing");
    assertNotNull("the pushed call rings", answer);
    mark("PUSH texts=" + screenTexts());
    // Find it again: reading the screen can outlast the heads-up's layout.
    answer = waitFor(sysButton("Answer"), 5_000);
    if (answer != null) {
      answer.click();
      mark("TAP heads-up Answer");
    } else {
      assertTrue("Answer in the shade", tapInShade("Answer", 5_000));
    }
    if (waitFor(By.descStartsWith("Call status: "), 15_000) == null) {
      shot("after-answer");
      launchApp();
      UiObject2 inApp = waitFor(By.res("sw-answer"), 5_000);
      mark("after Answer: no call screen; in-app sheet=" + (inApp != null));
    }
    needStatus("Connected", CONNECT_MS);
    String b = waitCalls(1, 15_000).get(0);
    assertSending(b, "push-answered");
    tap("sw-hangup", 5_000);
  }
}
