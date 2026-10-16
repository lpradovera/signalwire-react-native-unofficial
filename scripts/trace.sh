#!/usr/bin/env bash
#
# Prints one merged timeline of the last inbound attempt.
#
# The evidence for a single call is scattered across three places that no one
# can watch at once: NSLog on the device (push, CallKit), Metro (JavaScript —
# the SDK, the bridge dial), and the server (park, token redemption). Reading
# them separately is how "the push worked" and "the app was running a cached
# bundle" both looked true at the same time.
#
# Usage: scripts/trace.sh [minutes]   (default: last 5 minutes)
set -uo pipefail

SCRATCH="${SW_SCRATCH:?set SW_SCRATCH to the directory holding device-console.log, metro.log and server.log}"
MINUTES="${1:-5}"
SINCE=$(date -v-"${MINUTES}"M '+%H:%M:%S' 2>/dev/null || date -d "-${MINUTES} minutes" '+%H:%M:%S')

echo "=== last ${MINUTES}m (since ${SINCE}) ==="

{
  # Device: the native half. Strip the retry storms and audio-route chatter,
  # which drown everything else.
  grep -hE "SignalWireVoipPush|RNCallKeep\]\[(reportNewIncomingCall|CXProviderDelegate|startCall|requestTransaction|reportEndCallWithUUID)" \
    "$SCRATCH/device-console.log" 2>/dev/null \
    | sed -E 's/^[0-9-]+ ([0-9:]+)\.[0-9]+ [^ ]+ /\1 device  /'

  # Metro: the JavaScript half. Only the bridge decisions, not the wire dump.
  grep -hE "Adopted bridge call|Bound bridge call|Bridge dial failed|carries no bridge token|vanished" \
    "$SCRATCH/metro.log" 2>/dev/null \
    | sed -E 's/^.*(Adopted|Bound|Bridge dial failed|carries no|vanished)/'"$(date '+%H:%M:%S')"' js      \1/'

  # Server: every line it logs, failures included — a park that reached no
  # device, a hang-up for a missing SID or token, a rejected token, a failed
  # push and why, a caller leg that was or was not ended — with the fields
  # that say why. Keeping only the success lines made a failed attempt read
  # like a good one.
  python3 - "$SCRATCH/server.log" 2>/dev/null <<'PY'
import sys, json, datetime
FIELDS = ('callSid', 'externalUserId', 'delivered', 'attempted', 'pruned', 'reason',
          'error', 'failures', 'prunedReasons', 'state', 'connectState', 'waitedMs')
with open(sys.argv[1]) as log:
    for line in log:
        try:
            d = json.loads(line)
        except ValueError:
            continue
        if not isinstance(d, dict) or 'message' not in d:
            continue
        at = d.get('at')
        stamp = datetime.datetime.fromisoformat(at.replace('Z', '+00:00')).astimezone().strftime('%H:%M:%S') if at else '--:--:--'
        extra = ' '.join(f"{k}={json.dumps(d[k]) if not isinstance(d[k], str) else d[k]}" for k in FIELDS if k in d)
        print(f"{stamp} server  {d['message']} {extra}".rstrip())
PY
  # -s: lines from one source stay in the order they were logged when they
  # share a second, instead of being re-sorted by their text.
} | sort -s -k1,1 | awk -v since="$SINCE" '$1 >= since || $1 == "--:--:--"'
