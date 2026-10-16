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
# Every timed line is placed by its full date and time, so the window holds
# only events from the last N minutes, across midnight too. Lines that carry
# no time (Metro writes none) are listed after the timeline, in log order,
# never stamped with the time this runs.
#
# Usage: scripts/trace.sh [minutes]   (default: last 5 minutes)
set -uo pipefail

SCRATCH="${SW_SCRATCH:?set SW_SCRATCH to the directory holding device-console.log, metro.log and server.log}"
MINUTES="${1:-5}"

python3 - "$SCRATCH" "$MINUTES" <<'PY'
import datetime, json, os, re, sys

scratch, minutes = sys.argv[1], float(sys.argv[2])
now = datetime.datetime.now().astimezone()
since = now - datetime.timedelta(minutes=minutes)
print(f"=== last {sys.argv[2]}m (since {since:%Y-%m-%d %H:%M:%S}) ===")

timed, untimed = [], []


def lines(name):
    try:
        with open(os.path.join(scratch, name), errors='replace') as log:
            yield from (line.rstrip('\n') for line in log)
    except OSError:
        return


# Device: the native half, from `log show` (compact or default style; both
# start with the date and time, the default style adds a UTC offset). Strip
# the retry storms and audio-route chatter, which drown everything else.
DEVICE = re.compile(r'SignalWireVoipPush|RNCallKeep\]\[(reportNewIncomingCall|CXProviderDelegate|startCall|requestTransaction|reportEndCallWithUUID)')
STAMP = re.compile(r'^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)(?:\.\d+)?([+-]\d{4})?\s+(.*)$')
for line in lines('device-console.log'):
    if not DEVICE.search(line):
        continue
    m = STAMP.match(line)
    if not m:
        untimed.append(f"device  {line}")
        continue
    at = datetime.datetime.strptime(f"{m[1]} {m[2]}{m[3] or ''}", '%Y-%m-%d %H:%M:%S' + ('%z' if m[3] else ''))
    # No offset (compact style) means the Mac's local time.
    at = at.astimezone()
    # Drop the type column (compact: "Df Process[pid:tid] ..."), or the
    # thread, type, activity, PID and TTL columns (default: "0x1 Default 0x0
    # 123 0 Process: ...").
    rest = re.sub(r'^[A-Z][a-z]?\s+', '', m[4])
    rest = re.sub(r'^0x[0-9a-f]+\s+\S+\s+0x[0-9a-f]+\s+\d+\s+\d+\s+', '', rest)
    timed.append((at, f"device  {rest}"))

# Metro: the JavaScript half. Only the bridge decisions, not the wire dump.
# metro.log has no timestamps, so these cannot be windowed: the last few are
# listed after the timeline.
JS = re.compile(r'(Adopted bridge call|Bound bridge call|Bridge dial failed|carries no bridge token|vanished).*')
JS_LAST = 20
js = [f"js      {m[0]}" for m in (JS.search(line) for line in lines('metro.log')) if m]
untimed.extend(js[-JS_LAST:])

# Server: park and redemption.
SERVER = re.compile(r'Parked caller|Bridged device|Bridge token rejected')
for line in lines('server.log'):
    if not SERVER.search(line):
        continue
    try:
        d = json.loads(line)
    except ValueError:
        continue
    text = f"server  {d.get('message')} {d.get('callSid') or d.get('reason') or ''}".rstrip()
    at = d.get('at')
    if at:
        timed.append((datetime.datetime.fromisoformat(at.replace('Z', '+00:00')).astimezone(), text))
    else:
        untimed.append(text)

# sorted() is stable: lines from one source keep their logged order when
# they share a second.
for at, text in sorted((t for t in timed if t[0] >= since), key=lambda t: t[0]):
    print(f"{at:%H:%M:%S} {text}")

if untimed:
    print(f"--- no timestamp, so not placed or windowed (Metro: its last {JS_LAST} bridge lines) ---")
    for text in untimed:
        print(f"         {text}")
PY
