#!/usr/bin/env python3
"""Results ledger: never re-run a test case whose result already exists for the same code.

A result is keyed by (source, config, case). `source` is the identity of the code under
test: the commit plus a hash of any uncommitted diff (see `source`). A baseline such as
upstream main is therefore re-run only when its commit changes.

    runledger.py source  <repo> [paths...]          -> prints the source key for the tree
    runledger.py stamp   <dir> <repo> [paths...]    -> writes <dir>/SOURCE_KEY (call after a build)
    runledger.py need    <ledger> <source> <config> <launches> <case>...
                                                    -> prints the cases still lacking <launches> results
                                                       (stored results for the rest go to stderr)
    runledger.py record  <ledger> <source> <config> <log> [question...]
                                                    -> appends every `CASE case=<c> ok=<bool>` line in <log>
    runledger.py show    <ledger> [source]          -> per (source, config, case) pass counts

The ledger is JSON lines, one result per line. Exit status is 0 unless arguments are bad.
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from collections import defaultdict

CASE_RE = re.compile(r"CASE case=(\S+) ok=(true|false)")


def git(repo, *args):
    return subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, check=True).stdout


def source_key(repo, paths):
    head = git(repo, "rev-parse", "--short=10", "HEAD").strip()
    diff = git(repo, "diff", "HEAD", "--", *paths) if paths else git(repo, "diff", "HEAD")
    if not diff:
        return head
    return f"{head}+{hashlib.sha256(diff.encode()).hexdigest()[:10]}"


def load(ledger):
    if not os.path.exists(ledger):
        return []
    with open(ledger) as f:
        return [json.loads(line) for line in f if line.strip()]


def tally(rows, source=None):
    out = defaultdict(lambda: [0, 0])
    for r in rows:
        if source and r["source"] != source:
            continue
        t = out[(r["source"], r["config"], r["case"])]
        t[0] += r["ok"]
        t[1] += 1
    return out


def main(argv):
    if len(argv) < 2:
        sys.exit(__doc__)
    cmd, args = argv[1], argv[2:]
    if cmd == "source" and args:
        print(source_key(args[0], args[1:]))
    elif cmd == "stamp" and len(args) >= 2:
        key = source_key(args[1], args[2:])
        with open(os.path.join(args[0], "SOURCE_KEY"), "w") as f:
            f.write(key + "\n")
        print(key)
    elif cmd == "need" and len(args) >= 5:
        ledger, source, config, launches, cases = args[0], args[1], args[2], int(args[3]), args[4:]
        counts = tally(load(ledger), source)
        for case in cases:
            ok, n = counts.get((source, config, case), (0, 0))
            if n >= launches:
                print(f"reuse {case}: {ok}/{n} ({source}, {config})", file=sys.stderr)
            else:
                print(case)
    elif cmd == "record" and len(args) >= 4:
        ledger, source, config, log = args[:4]
        question = " ".join(args[4:])
        now = time.strftime("%Y-%m-%dT%H:%M:%S")
        added = 0
        with open(log, errors="replace") as f, open(ledger, "a") as out:
            for line in f:
                m = CASE_RE.search(line)
                if m:
                    out.write(json.dumps({"source": source, "config": config, "case": m.group(1),
                                          "ok": m.group(2) == "true", "at": now, "log": log,
                                          "question": question}) + "\n")
                    added += 1
        print(f"recorded {added} results for {source} ({config})")
    elif cmd == "show" and args:
        for (source, config, case), (ok, n) in sorted(tally(load(args[0]), args[1] if len(args) > 1 else None).items()):
            print(f"{source}\t{config}\t{case}\t{ok}/{n}")
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv)
