#!/usr/bin/env bash
#
# Brings the whole device-test environment up, down, or reports on it.
#
# A device test needs four things alive at once, and any one of them failing
# looks identical from the iPad: the call simply never arrives. This script
# starts them in dependency order and then *proves* each link rather than
# reporting "started", because every wasted loop in this project so far came
# from a link that was down while everything looked fine:
#
#   1. support server  :3000   mints tokens, sends pushes, parks callers
#   2. tailscale funnel :443   the only way SignalWire can reach the park
#                              webhook — without it a call dies before a push
#   3. metro           :8081   the app is a dev-client build; with no bundler
#                              it shows "No development server found" and no
#                              JavaScript runs, so no call can be answered
#   4. vite            :5173   the web tab used as the second subscriber
#
# It is idempotent: a service already listening is left alone. That matters —
# starting a second `tsx --watch` produced two supervisors racing for port 3000,
# and the loser exiting mid-push cancelled the APNs stream, which read exactly
# like a broken push.
#
# Usage:
#   scripts/dev.sh up        start whatever is not running, then verify
#   scripts/dev.sh down      stop everything (funnel first)
#   scripts/dev.sh status    report without changing anything
#   scripts/dev.sh verify    re-run the checks only
#
# Logs land in .dev/ under the names scripts/trace.sh expects, so
#   SW_SCRATCH=.dev scripts/trace.sh
# merges them straight away.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGS="${SW_SCRATCH:-$REPO/.dev}"
mkdir -p "$LOGS"

# The tailnet name, used for both the funnel and Metro. A physical device is not
# on the Mac's loopback and may not share its WiFi, so a tailnet hostname is the
# one address that works from anywhere. Falls back to whatever tailscale reports.
DEFAULT_HOST="$(tailscale status --json 2>/dev/null \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)"
SW_HOST="${SW_HOST:-${DEFAULT_HOST:-localhost}}"

green() { printf '\033[32m%s\033[0m\n' "$1"; }
red()   { printf '\033[31m%s\033[0m\n' "$1"; }
warn()  { printf '\033[33m%s\033[0m\n' "$1"; }

listening() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1; }

# Stops whatever owns a port, plus the supervisor that would restart it.
#
# By port rather than by `pkill -f <pattern>`: patterns like "expo start" or
# "tsx --watch" match every project on the machine, and this script has no
# business killing unrelated work. The parent is taken too because `npm run dev`
# and `npx expo start` both leave a supervisor that respawns the child.
stop_port() {
  local port="$1" label="$2" pid parent
  pid="$(listening "$port")"
  if [ -z "$pid" ]; then warn "$label not running"; return; fi
  parent="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
  kill "$pid" 2>/dev/null
  # Only walk up to a supervisor that is still one of ours, never to the shell.
  if [ -n "$parent" ] && [ "$parent" != "1" ] \
     && ps -o command= -p "$parent" 2>/dev/null | grep -qE 'npm|node|expo'; then
    kill "$parent" 2>/dev/null
  fi
  green "$label down"
}

# Waits for a URL to answer. Returns non-zero rather than hanging forever, so a
# failure is reported in seconds instead of discovered on the device minutes later.
wait_for() {
  local url="$1" tries="${2:-30}" i=0
  while [ "$i" -lt "$tries" ]; do
    if curl -fsS -o /dev/null -m 3 "$url" 2>/dev/null; then return 0; fi
    i=$((i + 1)); sleep 1
  done
  return 1
}

start_server() {
  if [ -n "$(listening 3000)" ]; then green "server  :3000  already up"; return; fi
  # One supervisor only. A stray watcher from an earlier session restarts on
  # every file save and fights for the port; see the header. Scoped to this
  # package's own command line so no other project's watcher is touched.
  pkill -f "rn-push-server" 2>/dev/null
  (cd "$REPO" && nohup npm run dev -w @signalwire/rn-push-server >"$LOGS/server.log" 2>&1 &)
  wait_for "http://127.0.0.1:3000/health" 30 \
    && green "server  :3000  started" \
    || { red "server  :3000  FAILED — see $LOGS/server.log"; tail -5 "$LOGS/server.log"; }
}

start_funnel() {
  if tailscale funnel status 2>/dev/null | grep -q 'proxy http://127.0.0.1:3000'; then
    green "funnel  :443   already up"; return
  fi
  tailscale funnel --bg 3000 >>"$LOGS/funnel.log" 2>&1 \
    && green "funnel  :443   started" \
    || red "funnel  :443   FAILED — run 'tailscale funnel --bg 3000' yourself; it needs your approval"
}

start_metro() {
  if [ -n "$(listening 8081)" ]; then green "metro   :8081  already up"; return; fi
  # Docker Desktop also likes 8081. If it holds the port, Metro silently never
  # binds and the app keeps showing "No development server found".
  (cd "$REPO/example" && REACT_NATIVE_PACKAGER_HOSTNAME="$SW_HOST" \
    nohup npx expo start --dev-client >"$LOGS/metro.log" 2>&1 &)
  wait_for "http://127.0.0.1:8081/status" 60 \
    && green "metro   :8081  started" \
    || { red "metro   :8081  FAILED — see $LOGS/metro.log"; tail -5 "$LOGS/metro.log"; }
}

start_vite() {
  if [ -n "$(listening 5173)" ]; then green "vite    :5173  already up"; return; fi
  (cd "$REPO" && nohup npm run dev -w @signalwire/react-web-example >"$LOGS/vite.log" 2>&1 &)
  wait_for "http://127.0.0.1:5173/" 30 \
    && green "vite    :5173  started" \
    || { red "vite    :5173  FAILED — see $LOGS/vite.log"; tail -5 "$LOGS/vite.log"; }
}

# The checks that matter. Each one is a link that has actually broken here, and
# each is verified end to end rather than by the presence of a process.
verify() {
  echo
  echo "=== verifying the chain ==="
  local ok=0

  curl -fsS -o /dev/null -m 5 "http://127.0.0.1:3000/health" \
    && green "server responds locally" || { red "server /health is down"; ok=1; }

  # From the public internet, which is the only view SignalWire has.
  curl -fsS -o /dev/null -m 15 "https://$SW_HOST/health" \
    && green "server reachable publicly (SignalWire can fetch the park SWML)" \
    || { red "public https://$SW_HOST/health unreachable — inbound calls cannot ring"; ok=1; }

  # Not just "Metro is listening" but "Metro can actually build the app". A
  # bundler that 500s on the entry file listens perfectly and serves nothing.
  local code
  code=$(curl -s -o /dev/null -m 240 -w '%{http_code}' \
    "http://127.0.0.1:8081/.expo/.virtual-metro-entry.bundle?platform=ios&dev=true&transform.engine=hermes")
  [ "$code" = "200" ] \
    && green "metro builds the iOS bundle (HTTP $code)" \
    || { red "metro cannot build the bundle (HTTP $code) — the app will not start"; ok=1; }

  # A registered device is what a push needs; zero means the app has not run
  # since the store was last cleared, and no push can be delivered to anyone.
  local devices
  devices=$(curl -fsS -m 5 "http://127.0.0.1:3000/devices?externalUserId=${SW_SUBSCRIBER:-rn-example}" 2>/dev/null \
    | python3 -c 'import sys,json;d=json.load(sys.stdin);print(len(d if isinstance(d,list) else d.get("devices",[])))' 2>/dev/null || echo 0)
  [ "$devices" -gt 0 ] \
    && green "$devices device(s) registered for push" \
    || warn "no device registered — open the app once so it registers its push token"

  echo
  [ "$ok" -eq 0 ] && green "chain is complete — ring with: scripts/ring.sh" \
                  || red "something above is broken; fix it before testing on the device"
  return "$ok"
}

status() {
  echo "=== ports ==="
  for entry in "3000 server" "5173 vite" "8081 metro"; do
    set -- $entry
    local pid; pid="$(listening "$1")"
    [ -n "$pid" ] && green "$2 ($1) up — pid $pid" || red "$2 ($1) down"
  done
  echo "=== funnel ==="
  tailscale funnel status 2>/dev/null | head -5 || echo "unavailable"
  echo "=== logs ==="
  echo "$LOGS"
}

down() {
  # Funnel first, always. It publishes a server running with
  # ALLOW_UNAUTHENTICATED_TOKENS=1, which mints a subscriber token for anyone
  # who asks. Leaving it up after a test session is the real hazard here.
  tailscale funnel --https=443 off >/dev/null 2>&1 && green "funnel down" || warn "funnel already off"
  stop_port 3000 "server"
  stop_port 8081 "metro"
  stop_port 5173 "vite"
  echo
  warn "device-console.log is not captured here — for the full trace.sh timeline,"
  warn "stream it from a paired iPad:  log stream --device-name '<iPad name>' > $LOGS/device-console.log"
}

case "${1:-up}" in
  up)
    echo "host: $SW_HOST   logs: $LOGS"
    echo
    start_server
    start_funnel
    start_metro
    start_vite
    verify
    echo
    warn "the funnel publishes :3000 to the internet with unauthenticated token"
    warn "minting enabled — run 'scripts/dev.sh down' when you stop testing."
    ;;
  down)   down ;;
  status) status ;;
  verify) verify ;;
  *) echo "usage: scripts/dev.sh [up|down|status|verify]" >&2; exit 2 ;;
esac
