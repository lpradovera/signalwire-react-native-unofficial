package com.signalwire.devicetests;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.content.Context;
import android.content.Intent;
import android.graphics.Rect;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.Log;

import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.BySelector;
import androidx.test.uiautomator.UiDevice;
import androidx.test.uiautomator.UiObject2;
import androidx.test.uiautomator.Until;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Rule;
import org.junit.rules.TestName;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Shared helpers for the device suite.
 *
 * <p>The app under test is driven from outside its process with UI Automator:
 * React Native's testID is the view's resource-id ({@code By.res("sw-hangup")}),
 * and system UI (the shade, the heads-up, the lock screen) is found by text.
 * Nothing is tapped by coordinates.
 *
 * <p>Audio evidence is the app's own RTP counters: with
 * {@code EXPO_PUBLIC_SW_DEV_STATS=1} the example logs a {@code [DEVSTATS]} line
 * per call every 2 s (packets received and sent). {@link #media} reads two of
 * them from logcat and turns them into packets per second. The host adds the
 * server's per-leg packet counts (REST) after each group.
 *
 * <p>Instrumentation arguments: {@code pkg} (the example's application id),
 * {@code hostPort} (hostd.py, reached as 10.0.2.2), {@code dest} (the address
 * outbound calls dial), {@code mode} (the build's label, for the log only).
 */
public abstract class SwBase {
  static final String TAG = "SWTEST";
  static final long CONNECT_MS = 25_000;

  @Rule public TestName testName = new TestName();

  protected UiDevice dev;
  protected Context ctx;
  protected String pkg;
  protected String host;
  /** The address outbound calls dial (instrumentation argument dest): it must answer and send audio. */
  protected String dest;
  /** Wall clock (device) at the start of the test, seconds: the DEVSTATS window. */
  protected double t0;
  protected File outDir;

  @Before
  public void baseSetUp() throws Exception {
    Bundle args = InstrumentationRegistry.getArguments();
    pkg = args.getString("pkg", "com.signalwire.rnexample.auto");
    host = "http://10.0.2.2:" + args.getString("hostPort", "0");
    dest = args.getString("dest", "/private/rn-device-test");
    dev = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
    ctx = InstrumentationRegistry.getInstrumentation().getContext();
    t0 = System.currentTimeMillis() / 1000.0;
    outDir = InstrumentationRegistry.getInstrumentation().getTargetContext().getExternalFilesDir(null);
    mark("BEGIN " + testName.getMethodName());
    wake();
    sh("svc wifi enable");
    sh("svc data enable");
  }

  @After
  public void baseTearDown() {
    mark("END " + testName.getMethodName());
    try {
      shot("teardown");
    } catch (Exception ignored) {
      // best effort
    }
    // Leave nothing running for the next test: wake, network on, every call
    // ended (in the app, then by REST for anything the app could not end).
    wake();
    sh("svc wifi enable");
    sh("svc data enable");
    for (int i = 0; i < 3; i++) {
      UiObject2 end = dev.findObject(By.res("sw-hangup"));
      if (end == null) {
        break;
      }
      end.click();
      SystemClock.sleep(1500);
    }
    try {
      JSONArray live = new JSONArray(http("/live"));
      for (int i = 0; i < live.length(); i++) {
        String id = live.getJSONObject(i).getString("id");
        mark("TEARDOWN ending live call " + id + " by REST");
        http("/end?id=" + id);
      }
    } catch (Exception e) {
      mark("TEARDOWN live check failed: " + e);
    }
  }

  // ---- logging and evidence -------------------------------------------------

  protected void mark(String message) {
    Log.i(TAG, message);
  }

  /** A screenshot and the window hierarchy, pulled by the host after the run. */
  protected void shot(String label) {
    String base = testName.getMethodName() + "__" + label;
    try {
      dev.takeScreenshot(new File(outDir, base + ".png"));
      try (FileOutputStream f = new FileOutputStream(new File(outDir, base + ".xml"))) {
        dev.dumpWindowHierarchy(f);
      }
      mark("SHOT " + base);
    } catch (Exception e) {
      mark("SHOT failed " + base + ": " + e);
    }
  }

  protected void failWith(String label, String message) {
    shot("FAIL-" + label);
    fail(message);
  }

  // ---- shell and host -------------------------------------------------------

  /** Runs a command as the shell user (no shell syntax: no pipes or redirects). */
  protected String sh(String command) {
    try {
      return dev.executeShellCommand(command);
    } catch (Exception e) {
      return "ERROR " + e;
    }
  }

  /** GET on hostd.py. */
  protected String http(String path) throws Exception {
    HttpURLConnection c = (HttpURLConnection) new URL(host + path).openConnection();
    c.setConnectTimeout(10_000);
    c.setReadTimeout(30_000);
    try {
      InputStream in = c.getResponseCode() < 400 ? c.getInputStream() : c.getErrorStream();
      ByteArrayOutputStream out = new ByteArrayOutputStream();
      byte[] buf = new byte[4096];
      int n;
      while (in != null && (n = in.read(buf)) > 0) {
        out.write(buf, 0, n);
      }
      return out.toString("UTF-8");
    } finally {
      c.disconnect();
    }
  }

  /** Rings the app's subscriber by REST; returns the REST call id. */
  protected String ringApp(String callerName) throws Exception {
    JSONObject r = new JSONObject(http("/inbound?name=" + java.net.URLEncoder.encode(callerName, "UTF-8")));
    mark("HOST inbound placed name=" + callerName + " -> " + r);
    assertEquals("REST dial status", 200, r.optInt("status"));
    return r.getString("id");
  }

  protected JSONObject restCall(String id) throws Exception {
    return new JSONObject(http("/call?id=" + id));
  }

  /** Waits for a REST call to reach a terminal status; returns seconds waited, or -1. */
  protected double waitRestEnded(String id, long ms) throws Exception {
    long start = SystemClock.uptimeMillis();
    while (SystemClock.uptimeMillis() - start < ms) {
      JSONObject c = restCall(id);
      String st = c.optString("status");
      if (st.equals("ended") || st.equals("completed") || st.equals("failed") || st.equals("busy")
          || st.equals("no-answer") || st.equals("canceled")) {
        double s = (SystemClock.uptimeMillis() - start) / 1000.0;
        mark("REST " + id + " " + st + " after " + s + " s");
        return s;
      }
      SystemClock.sleep(1000);
    }
    return -1;
  }

  /** The suite's live calls by REST. */
  protected JSONArray restLive() throws Exception {
    return new JSONArray(http("/live"));
  }

  // ---- device ---------------------------------------------------------------

  protected void wake() {
    try {
      dev.wakeUp();
    } catch (Exception ignored) {
      // best effort
    }
    sh("wm dismiss-keyguard");
  }

  protected void lockScreen() {
    sh("input keyevent 26");
    SystemClock.sleep(1200);
    mark("LOCKED interactive=" + isInteractive());
  }

  protected boolean isInteractive() {
    try {
      return dev.isScreenOn();
    } catch (Exception e) {
      return false;
    }
  }

  protected void launchApp() {
    // Through the shell: package visibility hides the app from this one.
    String component = null;
    for (String line : sh("cmd package resolve-activity --brief -c android.intent.category.LAUNCHER " + pkg).split("\n")) {
      if (line.trim().startsWith(pkg + "/")) {
        component = line.trim();
      }
    }
    assertNotNull("launcher activity of " + pkg, component);
    sh("am start -n " + component);
    dev.wait(Until.hasObject(By.pkg(pkg).depth(0)), 15_000);
  }

  protected void forceStop() {
    sh("am force-stop " + pkg);
    SystemClock.sleep(800);
  }

  // ---- UI -------------------------------------------------------------------

  protected UiObject2 waitFor(BySelector s, long ms) {
    return dev.wait(Until.findObject(s), ms);
  }

  protected UiObject2 need(BySelector s, long ms, String what) {
    UiObject2 o = waitFor(s, ms);
    if (o == null) {
      failWith(what.replaceAll("[^A-Za-z0-9]+", "-"), "not found within " + ms + " ms: " + what);
    }
    return o;
  }

  protected void tap(String resourceId, long ms) {
    need(By.res(resourceId), ms, resourceId).click();
    mark("TAP " + resourceId);
  }

  protected boolean gone(BySelector s, long ms) {
    return dev.wait(Until.gone(s), ms);
  }

  /** Home: connected, with the dial field and the Call button. */
  protected void needHome(long ms) {
    need(By.res("about"), ms, "Home (the About link)");
  }

  /** Launches (or brings forward) the app and waits for Home. */
  protected void openHome() {
    launchApp();
    needHome(40_000);
  }

  protected void dial(String destination) {
    UiObject2 field = need(By.clazz("android.widget.EditText"), 10_000, "the dial field");
    field.setText(destination);
    UiObject2 call = need(By.text("Call"), 5_000, "the Call button");
    call.click();
    mark("DIAL " + destination);
  }

  /** The CallStatus pill's label (content-desc "Call status: X"), or null. */
  protected String callStatus() {
    UiObject2 o = dev.findObject(By.descStartsWith("Call status: "));
    return o == null ? null : o.getContentDescription().substring("Call status: ".length());
  }

  protected void needStatus(String label, long ms) {
    UiObject2 o = waitFor(By.desc("Call status: " + label), ms);
    if (o == null) {
      failWith("status-" + label, "call status never read " + label + " (last: " + callStatus() + ")");
    }
    mark("STATUS " + label);
  }

  /** The visible text inside an element (its children's text joined). */
  /** The text under `o`, or its content description when it has none (a button named by its label). */
  protected String textOf(UiObject2 o) {
    StringBuilder sb = new StringBuilder();
    collect(o, sb);
    String text = sb.toString().trim();
    String desc = o.getContentDescription();
    return text.isEmpty() && desc != null ? desc.trim() : text;
  }

  private void collect(UiObject2 o, StringBuilder sb) {
    if (o.getText() != null && !o.getText().isEmpty()) {
      sb.append(o.getText()).append(' ');
    }
    for (UiObject2 c : o.getChildren()) {
      collect(c, sb);
    }
  }

  /** All visible text on screen. */
  protected List<String> screenTexts() {
    List<String> out = new ArrayList<>();
    for (UiObject2 o : dev.findObjects(By.textContains(""))) {
      if (o.getText() != null && !o.getText().isEmpty()) {
        out.add(o.getText());
      }
    }
    return out;
  }

  /** A system UI button (a notification action) by its content description. */
  protected BySelector sysButton(String label) {
    return By.pkg("com.android.systemui").desc(Pattern.compile("(?i)" + Pattern.quote(label)));
  }

  /**
   * The text on the incoming sheet (the caller name and buttons), and the name
   * checks. React Native's accessibility tree is flat here, so the sheet's
   * text is every text of the app inside the sheet's bounds.
   */
  protected String sheetName() {
    UiObject2 sheet = need(By.res("sw-incoming-sheet"), 20_000, "the incoming sheet");
    SystemClock.sleep(500);
    Rect box = sheet.getVisibleBounds();
    StringBuilder sb = new StringBuilder();
    for (UiObject2 o : dev.findObjects(By.pkg(pkg).text(Pattern.compile(".+")))) {
      if (box.contains(o.getVisibleBounds())) {
        sb.append(o.getText()).append(" | ");
      }
    }
    String text = sb.toString();
    mark("SHEET text=[" + text + "]");
    assertTrue("no _undef_ on the sheet: " + text, !text.contains("_undef_"));
    assertTrue("no sip: prefix on the sheet: " + text, !text.toLowerCase(Locale.ROOT).contains("sip:"));
    return text;
  }

  /** Bottom of the navigation bar's top edge (the inset), from dumpsys window; -1 if unknown. */
  protected int navBarTop() {
    String w = sh("dumpsys window");
    Matcher m = Pattern.compile("type=navigationBars[^\\n]*?frame=\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]").matcher(w);
    int top = -1;
    while (m.find()) {
      int t = Integer.parseInt(m.group(2));
      int b = Integer.parseInt(m.group(4));
      if (b > t && (top < 0 || t > top)) {
        top = t;
      }
    }
    return top;
  }

  /** The sheet's buttons sit above the navigation bar. */
  protected void checkSheetInsets() {
    int nav = navBarTop();
    int height = dev.getDisplayHeight();
    for (String id : new String[] {"sw-decline", "sw-answer", "sw-hold-accept", "sw-end-accept"}) {
      UiObject2 b = dev.findObject(By.res(id));
      if (b == null) {
        continue;
      }
      Rect r = b.getVisibleBounds();
      mark("INSETS " + id + " bounds=" + r.toShortString() + " navTop=" + nav + " display=" + height);
      assertTrue(id + " bottom " + r.bottom + " overlaps the navigation bar at " + nav, nav < 0 || r.bottom <= nav);
      assertTrue(id + " is off screen", r.bottom <= height && r.height() > 0);
    }
  }

  // ---- the screen at the ear -----------------------------------------------

  /** Whether the app holds its proximity screen-off lock (ProximityScreenModule), per dumpsys power. */
  protected boolean proximityLockHeld() {
    for (String line : sh("dumpsys power").split("\n")) {
      if (line.contains("PROXIMITY_SCREEN_OFF_WAKE_LOCK") && line.contains("SignalWire:proximity")) {
        return true;
      }
    }
    return false;
  }

  /** The built-in display's state (ON, OFF, ...), the first mState in dumpsys display. */
  protected String displayState() {
    Matcher m = Pattern.compile("mState=(\\w+)").matcher(sh("dumpsys display"));
    return m.find() ? m.group(1) : "?";
  }

  /**
   * The proximity lock follows the call's route (its route button's label):
   * held on the receiver, where covering the sensor turns the display off and
   * uncovering it turns it back on; never held on the speaker, Bluetooth or a
   * headset, where the display stays on with the sensor covered. Covers the
   * emulated sensor through hostd (`adb emu sensor set proximity`).
   */
  protected void assertProximityFollowsRoute(String routeLabel, String label) throws Exception {
    boolean earpiece = routeLabel.toLowerCase(Locale.ROOT).contains("earpiece");
    boolean held = proximityLockHeld();
    http("/emu?cmd=" + java.net.URLEncoder.encode("sensor set proximity 0", "UTF-8"));
    SystemClock.sleep(2_000);
    String near = displayState();
    boolean heldNear = proximityLockHeld();
    http("/emu?cmd=" + java.net.URLEncoder.encode("sensor set proximity 5", "UTF-8"));
    SystemClock.sleep(1_500);
    String far = displayState();
    mark("PROXIMITY " + label + " route=" + routeLabel + " lock=" + held + " lockNear=" + heldNear
        + " displayNear=" + near + " displayFar=" + far);
    assertEquals("the proximity lock on " + routeLabel, earpiece, held);
    assertEquals("the proximity lock with the sensor covered on " + routeLabel, earpiece, heldNear);
    assertEquals("the display with the sensor covered on " + routeLabel, earpiece ? "OFF" : "ON", near);
    assertEquals("the display once uncovered", "ON", far);
  }

  // ---- Telecom --------------------------------------------------------------

  /** Call states Telecom lists for the app ("ACTIVE", "ON_HOLD", "RINGING", ...). */
  protected List<String> telecomStates() {
    String d = sh("dumpsys telecom");
    List<String> states = new ArrayList<>();
    // "Call TC@12 [...] ... state=ACTIVE" lines of the live call list.
    int idx = d.indexOf("mCallsManager:");
    String calls = idx >= 0 ? d.substring(idx) : d;
    int end = calls.indexOf("mCallAudioManager");
    if (end > 0) {
      calls = calls.substring(0, end);
    }
    Matcher m = Pattern.compile("Call id=(TC@\\d+[_\\d]*), state=([A-Z_]+)").matcher(calls);
    Map<String, String> byId = new LinkedHashMap<>();
    while (m.find()) {
      byId.put(m.group(1), m.group(2));
    }
    if (byId.isEmpty()) {
      Matcher m2 = Pattern.compile("\\[(TC@\\d+[_\\d]*), ([A-Z_]+),").matcher(calls);
      while (m2.find()) {
        byId.put(m2.group(1), m2.group(2));
      }
    }
    states.addAll(byId.values());
    mark("TELECOM " + byId);
    return states;
  }

  // ---- DEVSTATS -------------------------------------------------------------

  static final Pattern DEVSTATS = Pattern.compile(
      "^\\s*(\\d+\\.\\d+)\\s.*\\[DEVSTATS\\] call=(\\S+) dir=(\\S+) status=(\\S+) held=(\\S+) in=(\\S+) out=(\\S+) senders=(\\S*)");

  /** One [DEVSTATS] sample. */
  public static final class Stat {
    double t;
    String call;
    String dir;
    String status;
    boolean held;
    long in;
    long out;
    String senders;

    @Override
    public String toString() {
      return String.format(Locale.ROOT, "%s %s %s held=%s in=%d out=%d %s", call.substring(0, 8), dir, status, held, in, out, senders);
    }
  }

  protected List<Stat> stats() {
    String log = sh(String.format(Locale.ROOT, "logcat -d -v epoch -T %.3f -s ReactNativeJS:V", t0));
    List<Stat> out = new ArrayList<>();
    for (String line : log.split("\n")) {
      Matcher m = DEVSTATS.matcher(line);
      if (m.find() && !m.group(6).equals("-")) {
        Stat s = new Stat();
        s.t = Double.parseDouble(m.group(1));
        s.call = m.group(2);
        s.dir = m.group(3);
        s.status = m.group(4);
        s.held = Boolean.parseBoolean(m.group(5));
        s.in = Long.parseLong(m.group(6));
        s.out = Long.parseLong(m.group(7).replaceAll("\\D", ""));
        s.senders = m.group(8).replaceAll("['\"]", "");
        out.add(s);
      }
    }
    return out;
  }

  /** The calls seen in DEVSTATS since the test began, oldest first. */
  protected List<String> calls() {
    List<String> ids = new ArrayList<>();
    for (Stat s : stats()) {
      if (!ids.contains(s.call)) {
        ids.add(s.call);
      }
    }
    return ids;
  }

  /** Waits until DEVSTATS has seen n calls; returns them. */
  protected List<String> waitCalls(int n, long ms) {
    long start = SystemClock.uptimeMillis();
    List<String> ids = calls();
    while (ids.size() < n && SystemClock.uptimeMillis() - start < ms) {
      SystemClock.sleep(1000);
      ids = calls();
    }
    if (ids.size() < n) {
      failWith("calls", "expected " + n + " calls in DEVSTATS, saw " + ids);
    }
    return ids;
  }

  protected Stat latest(String call) {
    Stat last = null;
    for (Stat s : stats()) {
      if (s.call.equals(call)) {
        last = s;
      }
    }
    return last;
  }

  /** Packets per second for a call over about windowMs: {in, out}, and the last sample. */
  protected double[] rates(String call, long windowMs, Stat[] lastOut) {
    Stat a = latest(call);
    SystemClock.sleep(windowMs);
    Stat b = latest(call);
    if (a == null || b == null || b.t <= a.t) {
      return null;
    }
    lastOut[0] = b;
    return new double[] {(b.in - a.in) / (b.t - a.t), (b.out - a.out) / (b.t - a.t)};
  }

  /**
   * Audio both ways on a call: the app received and sent at least 20 packets/s
   * over about 5 s (Opus at 20 ms is 50/s). Run after every switch: the iOS
   * defect this guards against was the microphone dying after a switch.
   */
  protected void assertSending(String call, String label) {
    Stat[] last = new Stat[1];
    double[] r = rates(call, 5000, last);
    if (r == null) {
      failWith("media-" + label, "no DEVSTATS samples for " + call + " at " + label);
    }
    mark(String.format(Locale.ROOT, "MEDIA %s call=%s live in/s=%.1f out/s=%.1f [%s]", label, call.substring(0, 8), r[0], r[1], last[0]));
    if (r[0] < 20 || r[1] < 20) {
      failWith("media-" + label, String.format(Locale.ROOT, "%s: call %s carries no audio both ways (in %.1f/s, out %.1f/s)", label, call, r[0], r[1]));
    }
  }

  /** A held call: no RTP either way, its audio sender paused. */
  protected void assertHeld(String call, String label) {
    Stat[] last = new Stat[1];
    double[] r = rates(call, 5000, last);
    if (r == null) {
      failWith("held-" + label, "no DEVSTATS samples for " + call + " at " + label);
    }
    mark(String.format(Locale.ROOT, "MEDIA %s call=%s held in/s=%.1f out/s=%.1f [%s]", label, call.substring(0, 8), r[0], r[1], last[0]));
    if (r[0] > 2 || r[1] > 2 || !last[0].held || !last[0].senders.contains("audio:paused")) {
      failWith("held-" + label, String.format(Locale.ROOT, "%s: held call %s still has media (in %.1f/s, out %.1f/s) or is not paused [%s]", label, call, r[0], r[1], last[0]));
    }
  }

  /**
   * One 5 s window over two calls after a switch: the live one carries audio
   * both ways, the held one none, with its sender paused.
   */
  protected void assertSwitch(String live, String held, String label) {
    Stat a0 = latest(live);
    Stat h0 = latest(held);
    SystemClock.sleep(5000);
    Stat a1 = latest(live);
    Stat h1 = latest(held);
    if (a0 == null || a1 == null || h0 == null || h1 == null || a1.t <= a0.t || h1.t <= h0.t) {
      failWith("switch-" + label, "no fresh DEVSTATS samples at " + label);
    }
    double ai = (a1.in - a0.in) / (a1.t - a0.t);
    double ao = (a1.out - a0.out) / (a1.t - a0.t);
    double hi = (h1.in - h0.in) / (h1.t - h0.t);
    double ho = (h1.out - h0.out) / (h1.t - h0.t);
    mark(String.format(Locale.ROOT, "MEDIA %s live=%s in/s=%.1f out/s=%.1f [%s] | held=%s in/s=%.1f out/s=%.1f [%s]",
        label, live.substring(0, 8), ai, ao, a1, held.substring(0, 8), hi, ho, h1));
    if (ai < 20 || ao < 20) {
      failWith("switch-" + label, String.format(Locale.ROOT, "%s: live call %s has no audio both ways (in %.1f/s, out %.1f/s)", label, live, ai, ao));
    }
    if (hi > 2 || ho > 2 || !h1.held || !h1.senders.contains("audio:paused")) {
      failWith("switch-" + label, String.format(Locale.ROOT, "%s: held call %s still has media or is not paused (in %.1f/s, out %.1f/s) [%s]", label, held, hi, ho, h1));
    }
  }

  /** The app's capture as AudioService sees it: "silenced:false", "silenced:true", or "none". */
  protected String recordingSilenced() {
    String d = sh("dumpsys audio");
    String found = "none";
    for (String line : d.split("\n")) {
      if (line.contains("silenced:") && (line.contains(pkg) || line.contains("VOICE_COMMUNICATION"))) {
        Matcher m = Pattern.compile("silenced:(\\w+)").matcher(line);
        if (m.find()) {
          found = "silenced:" + m.group(1);
          if (m.group(1).equals("true")) {
            return found;
          }
        }
      }
    }
    return found;
  }

  /** Foreground services of the app, from dumpsys (isForeground and types). */
  protected String foregroundServices() {
    String d = sh("dumpsys activity services " + pkg);
    StringBuilder sb = new StringBuilder();
    for (String line : d.split("\n")) {
      String l = line.trim();
      if (l.startsWith("* ServiceRecord") || l.startsWith("isForeground=") || l.contains("foregroundServiceType")) {
        sb.append(l).append(" | ");
      }
    }
    return sb.toString();
  }

  /**
   * Packets per second across a window the JS timers could not sample
   * (React Native pauses them while the app is in the background or the
   * screen is off): getStats counters are cumulative, so the first sample
   * after the window against the last one before it gives the rate inside.
   * Returns {in/s, out/s, seconds}.
   */
  protected double[] rateAcross(String call, Stat before, String label) {
    double since = System.currentTimeMillis() / 1000.0;
    Stat after = null;
    long start = SystemClock.uptimeMillis();
    while (SystemClock.uptimeMillis() - start < 8_000) {
      Stat s = latest(call);
      if (s != null && s.t > since) {
        after = s;
        break;
      }
      SystemClock.sleep(500);
    }
    if (before == null || after == null) {
      failWith("across-" + label, "no DEVSTATS sample around " + label);
    }
    double dt = after.t - before.t;
    double in = (after.in - before.in) / dt;
    double out = (after.out - before.out) / dt;
    mark(String.format(Locale.ROOT, "MEDIA %s across %.1f s call=%s in/s=%.1f out/s=%.1f [%s -> %s]", label, dt, call.substring(0, 8), in, out, before, after));
    return new double[] {in, out, dt};
  }

  /** The REST leg's packet counts once the server has them: {from the app, to the app}. */
  protected long[] restPackets(String id) throws Exception {
    long start = SystemClock.uptimeMillis();
    while (SystemClock.uptimeMillis() - start < 20_000) {
      JSONObject c = restCall(id);
      if (!c.isNull("in_pkts") && !c.isNull("out_pkts")) {
        long[] r = {c.getLong("in_pkts"), c.getLong("out_pkts")};
        mark("REST packets " + id + " from-app=" + r[0] + " to-app=" + r[1] + " duration=" + c.opt("duration"));
        return r;
      }
      SystemClock.sleep(1_500);
    }
    return null;
  }

  /** The logcat since the test began, filtered to lines containing needle. */
  protected List<String> logLines(String needle) {
    String log = sh(String.format(Locale.ROOT, "logcat -d -v epoch -T %.3f", t0));
    List<String> out = new ArrayList<>();
    for (String line : log.split("\n")) {
      if (line.contains(needle)) {
        out.add(line);
      }
    }
    return out;
  }

  /**
   * The call-waiting mode the running app was set up with, from the last
   * "CallKit ready (callWaiting: X, endCallsOnHostDestroy: Y)" line; the app
   * is restarted once if the line has left the log buffer.
   */
  protected String launchedMode() {
    for (int attempt = 0; attempt < 2; attempt++) {
      String log = sh("logcat -d -s ReactNativeJS:V");
      Matcher m = Pattern.compile("CallKit ready \\(callWaiting: (\\w+), endCallsOnHostDestroy: (\\w+)\\)").matcher(log);
      String mode = null;
      while (m.find()) {
        mode = m.group(1) + (m.group(2).equals("true") ? "+endOnBack" : "");
      }
      if (mode != null) {
        mark("MODE " + mode);
        return mode;
      }
      forceStop();
      openHome();
    }
    return null;
  }

  // ---- notifications --------------------------------------------------------

  /** Taps a button (by text) in the notification shade; true if found. */
  protected boolean tapInShade(String text, long ms) {
    dev.openNotification();
    UiObject2 b = waitFor(By.pkg("com.android.systemui").desc(Pattern.compile("(?i)" + Pattern.quote(text))), ms);
    if (b == null) {
      b = waitFor(By.text(Pattern.compile("(?i).*" + Pattern.quote(text) + ".*")), 1_000);
    }
    if (b == null) {
      shot("shade-no-" + text.replaceAll("\\W+", "-"));
      dev.pressBack();
      return false;
    }
    b.click();
    mark("SHADE TAP " + text);
    return true;
  }

  protected void closeShade() {
    sh("cmd statusbar collapse");
  }
}
