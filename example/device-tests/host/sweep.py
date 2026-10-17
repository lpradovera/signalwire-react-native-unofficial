"""sweep.py [--report]: end the suite's live test calls by REST, then print the
calls since SINCE, their minutes, and the LaML in-progress count."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import swrest  # noqa: E402


def rest():
    return swrest.Rest(os.environ['SW_ENV_FILE'], os.environ['SINCE'], os.environ.get('SW_MATCH', 'rn-device-test,rn-example').split(','))


def sweep(quiet=False, report=False):
    r = rest()
    mine = r.mine(pages=6)
    live = [x for x in mine if x['status'] not in swrest.DONE]
    lines = []
    for x in live:
        lines.append(f'SWEEP ENDED {x["id"]} {x["status"]} -> {r.end(x["id"])}')
    minutes = sum((x.get('billing_ms') or x.get('duration_ms') or 0) for x in mine) / 60000
    longest = max([x.get('duration') or 0 for x in mine] or [0])
    s, n = r.laml_in_progress()
    lines.append(f'calls={len(mine)} live_before_sweep={len(live)} minutes={minutes:.2f} longest={longest}s laml_in_progress={n} (http {s})')
    if report:
        for x in sorted(mine, key=lambda x: x['created_at']):
            sm = swrest.summary(x)
            lines.append(f"{sm['created_at']} {sm['id']} {sm['status']} {sm['duration']}s billing_ms={sm['billing_ms']} to={sm['to']} in={sm['in_pkts']} out={sm['out_pkts']}")
    return '\n'.join(lines)


if __name__ == '__main__':
    print(sweep(report='--report' in sys.argv))
