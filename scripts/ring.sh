#!/usr/bin/env bash
#
# Rings the device, without a caller.
#
# The full inbound test needs a browser tab, a microphone grant and a parked
# SignalWire call before the phone even rings — a minute of setup to exercise
# three seconds of device behaviour. This posts the park script directly, so
# the push, the CallKit screen, the answer, the bridge dial and the token
# redemption all run in about ten seconds.
#
# What it does NOT test: the media join. The call SID is synthetic, so
# SignalWire's `connect` at the end has nothing real to connect to. Everything
# up to and including "Bridged device to parked caller" in the server log is
# genuine. Use a real call for the last mile.
#
# Usage: scripts/ring.sh [subscriber]
set -euo pipefail

SERVER="${SW_SERVER:-http://127.0.0.1:3000}"
SUBSCRIBER="${1:-rn-example}"
CALL_SID="synthetic-$(date +%s)"

curl -sS -X POST "$SERVER/swml/park" \
  -H 'content-type: application/json' \
  -d "{\"params\":{\"call\":{\"call_id\":\"$CALL_SID\",\"to\":\"/public/rn-example-park\",\"from\":\"+15551234567\",\"from_name\":\"Fast Loop\"},\"vars\":{\"subscriber\":\"$SUBSCRIBER\"}}}" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('park SWML:', [list(v)[0] for v in d['sections']['main']])"

echo "rang $SUBSCRIBER (sid $CALL_SID) — answer on the device, then: scripts/trace.sh"
