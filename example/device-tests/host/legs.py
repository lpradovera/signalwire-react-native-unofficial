"""legs.py <run_dir>: the per-call audio evidence of one test run.

1. A timeline from logcat.txt: the test's SWTEST markers, and each call's
   [DEVSTATS] samples as deltas (packets received / sent since the previous
   sample, 2 s apart), so every switch shows whether each call still carries
   audio both ways.
2. Each REST leg created during the run: status, duration, and the packets
   SignalWire received from the app (in) and sent to it (out).
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

DEV = re.compile(r'^\s*(\d+\.\d+)\s.*\[DEVSTATS\] call=(\S+) dir=(\S+) status=(\S+) held=(\S+) in=(\d+) out=(\d+) senders=([^\s\']*)')
MARK = re.compile(r'^\s*(\d+\.\d+)\s.*\sSWTEST\s*: (.*)$')
APP = re.compile(r'^\s*(\d+\.\d+)\s.*ReactNativeJS: (.*(?:Token renewed|push is off|CallKit ready|Refusing inbound|CallInProgressError|rejected by user|Authentication).*)$')


def timeline(run):
    path = os.path.join(run, 'logcat.txt')
    if not os.path.exists(path):
        return []
    rows, last = [], {}
    for line in open(path, errors='replace'):
        m = MARK.match(line)
        if m:
            if not m.group(2).startswith('SHOT'):
                rows.append((float(m.group(1)), 'T  ' + m.group(2)[:200]))
            continue
        m = DEV.match(line)
        if m:
            t, c, d, st, held, i, o, snd = float(m.group(1)), m.group(2)[:8], m.group(3), m.group(4), m.group(5), int(m.group(6)), int(m.group(7)), m.group(8)
            pi, po = last.get(c, (i, o))
            last[c] = (i, o)
            rows.append((t, f'S  {c} {d:<8} {st:<10} held={held:<5} in={i:>5} (+{i - pi:>3})  out={o:>5} (+{o - po:>3})  {snd}'))
            continue
        m = APP.match(line)
        if m:
            rows.append((float(m.group(1)), 'A  ' + m.group(2)[:200]))
    return sorted(rows)


def rest_legs(started, ended):
    import swrest
    import sweep
    rest = sweep.rest()
    out = []
    for x in rest.mine(pages=2):
        created = swrest.age(x)
        # created within the run window (with a little slack)
        import time
        t_created = time.time() - created
        if started - 5 <= t_created <= ended + 5:
            full = rest.call(x['id']) or x
            s = swrest.summary(full)
            out.append(f"{s['created_at']} {s['id']} {s['status']:<9} {s['duration']}s to={s['to']} "
                       f"REST in(from app)={s['in_pkts']} out(to app)={s['out_pkts']}")
    return sorted(out)


def report(run, started=None, ended=None):
    lines = [f'{t:.1f} {x}' for t, x in timeline(run)]
    if started is not None:
        lines.append('')
        lines.append('REST legs created during the run:')
        try:
            lines.extend(rest_legs(started, ended))
        except Exception as e:  # report what failed instead of hiding it
            lines.append(f'REST lookup failed: {e!r}')
    return '\n'.join(lines) + '\n'


if __name__ == '__main__':
    print(report(sys.argv[1]))
