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

  # Server: park and redemption.
  grep -hE "Parked caller|Bridged device|Bridge token rejected" "$SCRATCH/server.log" 2>/dev/null \
    | python3 -c "
import sys, json, datetime
for line in sys.stdin:
    try:
        d = json.loads(line)
    except ValueError:
        continue
    at = d.get('at')
    stamp = datetime.datetime.fromisoformat(at.replace('Z','+00:00')).astimezone().strftime('%H:%M:%S') if at else '        '
    print(f\"{stamp} server  {d.get('message')} {d.get('callSid') or d.get('reason') or ''}\")
"
} | sort -k1,1 | awk -v since="$SINCE" '$1 >= since || $1 == ""'
