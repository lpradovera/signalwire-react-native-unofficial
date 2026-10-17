#!/usr/bin/env bash
# The Android device suite: builds the example in each configuration the
# scenarios need, runs the UI Automator tests on a running emulator, and
# places and checks calls through SignalWire's REST API.
#
#   example/device-tests/suite.sh [group ...]        (default: all)
#
# Groups (calls each, at most 60 s per call):
#   launch      A1 fresh install, permission prompts, one "push is off"   (0)
#   calls       A2 outbound, A3 answer / decline over About, A4 heads-up  (4)
#   cw          call waiting: Hold & Accept + swaps, Decline + End &
#               Accept, Dial again + a third call busy                    (8)
#   back        locked 15 s then Back keeps the call; answer while locked (2)
#   connection  401 from the token server, the reconnect banner            (0)
#   endonback   EXPO_PUBLIC_SW_END_CALLS_ON_BACK=1: Back ends the call     (1)
#   modes       'endAndAccept' and 'single' builds                         (5)
#   nocallkit   EXPO_PUBLIC_SW_CALLKIT=0: the mic stays live when locked   (1)
#   push        a build with a simulated FCM receiver: pushed call with
#               the app killed; token renewal (TTL 120) then a push       (2)
#
# Needs: a booted emulator (ANDROID_SERIAL), the Android SDK and JDK 17 on
# PATH, `npm ci` done, and settings in example/device-tests/suite.env
# (gitignored; see docs/device-testing.md):
#   SW_ENV_FILE          the token server's env file (SIGNALWIRE_SPACE,
#                        SIGNALWIRE_PROJECT_ID, SIGNALWIRE_API_TOKEN,
#                        ALLOW_UNAUTHENTICATED_TOKENS=1,
#                        DEV_SUBSCRIBER_REFERENCE); never printed
#   SW_SUBSCRIBER        the app's address, e.g. /private/rn-example
#   SW_INBOUND_URL       SWML (or a relay bin) the inbound test caller runs
#                        when answered: it must send audio (silence is fine)
#   SW_TEST_DESTINATION  an address outbound calls dial that answers and
#                        sends audio, e.g. /private/rn-device-test
#   SW_MATCH             to/from substrings that mark the suite's calls for
#                        the watchdog and the sweep (default: the two above)
#   SW_APP_ID            the build's application id (default
#                        com.signalwire.rnexample.suite)
#
# Everything it writes goes to example/device-tests/.out/ (gitignored).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="$HERE/.out"
mkdir -p "$OUT/logs" "$OUT/apk" "$OUT/runs"
[ -f "$HERE/suite.env" ] && source "$HERE/suite.env"

: "${ANDROID_SERIAL:?set ANDROID_SERIAL (adb devices)}"
: "${SW_ENV_FILE:?set SW_ENV_FILE in suite.env}"
: "${SW_SUBSCRIBER:?set SW_SUBSCRIBER in suite.env}"
: "${SW_INBOUND_URL:?set SW_INBOUND_URL in suite.env}"
: "${SW_TEST_DESTINATION:?set SW_TEST_DESTINATION in suite.env}"
case "$SW_ENV_FILE" in /*) ;; *) SW_ENV_FILE="$HERE/$SW_ENV_FILE" ;; esac
export ANDROID_SERIAL SW_ENV_FILE SW_SUBSCRIBER SW_INBOUND_URL SW_TEST_DESTINATION
export SW_MATCH="${SW_MATCH:-${SW_TEST_DESTINATION##*/},${SW_SUBSCRIBER##*/}}"
export APP_PKG="${SW_APP_ID:-com.signalwire.rnexample.suite}"
export ADB_MDNS=0 SUITE_DIR="$OUT"
export SINCE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

free_port() { python3 -c "import socket;s=socket.socket();s.bind(('127.0.0.1',0));print(s.getsockname()[1])"; }
export HOSTD_PORT="$(free_port)" SERVER_PORT="$(free_port)"
export TOKEN_UPSTREAM="http://127.0.0.1:$SERVER_PORT" RUN_DIR="$OUT/logs"

SERVER_PID="" HOSTD_PID=""
start_server() { # $1: token lifetime in seconds
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null && wait "$SERVER_PID" 2>/dev/null
  (cd "$ROOT/server" && PORT=$SERVER_PORT TOKEN_TTL_SECONDS="$1" DEVICE_STORE_PATH="$OUT/devices.json" \
    exec node --import tsx --env-file="$SW_ENV_FILE" src/index.ts >> "$OUT/logs/server.log" 2>&1) &
  SERVER_PID=$!
  for _ in $(seq 30); do curl -s -o /dev/null "$TOKEN_UPSTREAM/" && break; sleep 1; done
  echo "token server on $SERVER_PORT (TTL $1 s)"
}
cleanup() {
  [ -n "$HOSTD_PID" ] && kill "$HOSTD_PID" 2>/dev/null
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
  python3 -I "$HERE/host/sweep.py" --report > "$OUT/calls.txt" 2>&1
  grep '^calls=' "$OUT/calls.txt"  # the run's calls, minutes, and what was left live
}
trap cleanup EXIT

start_server 7200
python3 -I "$HERE/host/hostd.py" >> "$OUT/logs/hostd.out" 2>&1 &
HOSTD_PID=$!
sleep 1

# build <tag> [--prebuild] [ENV=VALUE ...]: a release APK of the example (arm64).
# The Metro cache is cleared every time: a cached bundle keeps the previous
# build's EXPO_PUBLIC_ values. --prebuild regenerates example/android (the
# first build, and any native change such as google-services.json).
build() {
  local tag="$1"; shift; local prebuild=0
  [ "${1:-}" = --prebuild ] && { prebuild=1; shift; }
  local log="$OUT/logs/build-$tag.log"
  rm -rf "$ROOT/node_modules/.cache/metro" "$ROOT/node_modules/.cache/metro-file-map" \
         "$ROOT/example/node_modules/.cache/metro" "$ROOT/example/node_modules/.cache/metro-file-map"
  (cd "$ROOT" && npm run build) > "$log" 2>&1 || { echo "npm run build failed: $log"; return 1; }
  (
    cd "$ROOT/example" || exit 1
    unset GOOGLE_SERVICES_JSON EXPO_PUBLIC_SW_CALLKIT EXPO_PUBLIC_SW_CALL_WAITING EXPO_PUBLIC_SW_END_CALLS_ON_BACK EXPO_PUBLIC_SW_BRIDGE_ADDRESS
    export SW_APP_ID="$APP_PKG" CI=1 EXPO_PUBLIC_SW_WIRE_LOG=0 EXPO_PUBLIC_SW_DEV_STATS=1
    export EXPO_PUBLIC_SW_TOKEN_URL="http://10.0.2.2:$HOSTD_PORT/token"
    export EXPO_PUBLIC_SW_DEV_DIAL_AGAIN="$SW_TEST_DESTINATION"
    for kv in "$@"; do export "$kv"; done
    if [ $prebuild = 1 ]; then
      npx expo prebuild --clean --platform android --no-install || exit 1
      [ -n "${GOOGLE_SERVICES_JSON:-}" ] && { "$HERE/apply-fcm-harness.sh" "$ROOT/example/android" || exit 1; }
    fi
    cd android || exit 1
    rm -rf app/build/generated/assets/createBundleReleaseJsAndAssets app/build/generated/res/createBundleReleaseJsAndAssets
    ./gradlew assembleRelease --no-daemon -PreactNativeArchitectures=arm64-v8a || exit 1
    cp app/build/outputs/apk/release/app-release.apk "$OUT/apk/$tag.apk"
  ) >> "$log" 2>&1 || { echo "build $tag failed: $log"; return 1; }
  echo "built $tag"
}

TESTS_BUILT=0
build_tests() {
  [ $TESTS_BUILT = 1 ] && return 0
  local p="$HERE/android"
  "$ROOT/example/android/gradlew" -p "$p" --no-daemon -q assembleDebug assembleDebugAndroidTest > "$OUT/logs/build-tests.log" 2>&1 \
    || { echo "test APK build failed: $OUT/logs/build-tests.log"; return 1; }
  adb install -r "$p/suite/build/outputs/apk/debug/suite-debug.apk" > /dev/null
  adb install -r -t "$p/suite/build/outputs/apk/androidTest/debug/suite-debug-androidTest.apk" > /dev/null
  TESTS_BUILT=1
}

run() { python3 -I "$HERE/host/run.py" "$@"; }

GROUPS_TO_RUN=("$@")
[ ${#GROUPS_TO_RUN[@]} = 0 ] && GROUPS_TO_RUN=(launch calls cw back connection endonback modes nocallkit push)
FULL_BUILT=0
full() { [ $FULL_BUILT = 1 ] || { build full --prebuild && FULL_BUILT=1; } && build_tests; }

for group in "${GROUPS_TO_RUN[@]}"; do
  echo "== $group"
  case "$group" in
    launch) full && run --apk "$OUT/apk/full.apk" --fresh --tag full 'LaunchTest#a1FreshInstall' ;;
    calls) full && run --apk "$OUT/apk/full.apk" --tag full 'CallTest#a2Outbound' 'CallTest#a3InboundAnswer' \
      'CallTest#a3DeclineOverAbout' 'CallTest#a4InboundBackground' ;;
    cw) full && run --apk "$OUT/apk/full.apk" --tag full 'CallWaitingTest#cwHoldAcceptSwapEnd' \
      'CallWaitingTest#cwDeclineThenEndAccept' 'CallWaitingTest#cwDialAgainThirdBusy' ;;
    back) full && run --apk "$OUT/apk/full.apk" --tag full 'BackgroundTest#lockThenBackKeepsCall' \
      'BackgroundTest#answerOnLockScreen' ;;
    connection) full && run --apk "$OUT/apk/full.apk" --tag full 'ConnectionTest#tokenRefused401' 'ConnectionTest#reconnectBanner' ;;
    endonback) full && build endonback EXPO_PUBLIC_SW_END_CALLS_ON_BACK=1 \
      && run --apk "$OUT/apk/endonback.apk" --tag endonback 'BackgroundTest#backEndsCall' ;;
    modes) full && build eaa EXPO_PUBLIC_SW_CALL_WAITING=endAndAccept \
      && run --apk "$OUT/apk/eaa.apk" --tag endAndAccept 'ModeTest#endAndAcceptMode' \
      && build single EXPO_PUBLIC_SW_CALL_WAITING=single \
      && run --apk "$OUT/apk/single.apk" --tag single 'ModeTest#singleMode' ;;
    nocallkit) full && build nocallkit EXPO_PUBLIC_SW_CALLKIT=0 \
      && run --apk "$OUT/apk/nocallkit.apk" --tag nocallkit 'BackgroundTest#lockedMicWithoutCallKit' ;;
    push)
      python3 - "$APP_PKG" "$OUT/google-services.json" <<'EOF'
import json, sys
# A placeholder Firebase project: links Firebase into the build so the
# simulated receiver can hand React Native Firebase a data message. It never
# reaches Google.
json.dump({'project_info': {'project_number': '000000000000', 'project_id': 'sw-device-suite-placeholder'},
           'client': [{'client_info': {'mobilesdk_app_id': '1:000000000000:android:0000000000000000',
                                       'android_client_info': {'package_name': sys.argv[1]}},
                       'oauth_client': [], 'api_key': [{'current_key': 'AIza' + '0' * 35}],
                       'services': {'appinvite_service': {'other_platform_oauth_client': []}}}],
           'configuration_version': '1'}, open(sys.argv[2], 'w'), indent=1)
EOF
      FULL_BUILT=0  # the push build's prebuild replaces example/android
      build push --prebuild GOOGLE_SERVICES_JSON="$OUT/google-services.json" EXPO_PUBLIC_SW_BRIDGE_ADDRESS="$SW_TEST_DESTINATION" \
        && build_tests && run --apk "$OUT/apk/push.apk" --tag push 'ConnectionTest#pushWakeAnswer' \
        && start_server 120 && adb shell am force-stop "$APP_PKG" \
        && run --tag push-ttl120 --timeout 600 'ConnectionTest#tokenRenewalThenPush'
      start_server 7200 ;;
    *) echo "unknown group: $group" ;;
  esac
done
