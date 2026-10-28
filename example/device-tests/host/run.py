"""Runs device-suite tests on the emulator, one instrumentation run per test.

usage: run.py [--apk PATH] [--fresh] [--timeout S] [--tag T] Class#method [Class#method ...]

  --apk PATH   install this build of the example first (kept if already installed)
  --fresh      uninstall the example first (a fresh install: permission prompts);
               otherwise the runtime permissions are granted with `pm grant`
  --tag T      a label for the run directories (the build's mode)

Each test gets runs/<method>[-tag]-<HHMMSS>/ with logcat.txt (epoch times),
instrument.txt, evidence/ (screenshots and window dumps the test took),
legs.txt (DEVSTATS per call between the test's SWTEST markers, and each
call's REST packet counts) and result.txt. After each test the suite's live
calls are swept by REST. Environment (ANDROID_SERIAL, APP_PKG,
HOSTD_PORT, SW_ENV_FILE, SW_MATCH, SW_TEST_DESTINATION, SUITE_DIR, SINCE); suite.sh
sets them.

With the results ledger (RUNLEDGER, LEDGER, SOURCE_KEY, Q; suite.sh sets them
when RUNLEDGER is given) a test that already has ROUNDS results for this code
and build (config emu-<tag>) is skipped, and each run is recorded with the
question. FORCE=1 (with REASON) runs them anyway.
"""
import hashlib
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import legs  # noqa: E402
import sweep  # noqa: E402

SUITE = os.environ['SUITE_DIR']
PKG = os.environ['APP_PKG']
TEST_PKG = 'com.signalwire.devicetests'
RUNNER = f'{TEST_PKG}.test/androidx.test.runner.AndroidJUnitRunner'
PERMS = ['RECORD_AUDIO', 'READ_PHONE_NUMBERS', 'READ_PHONE_STATE', 'CALL_PHONE', 'POST_NOTIFICATIONS', 'BLUETOOTH_CONNECT']


def adb(*args, timeout=120, check=False):
    r = subprocess.run(['adb', *args], capture_output=True, text=True, timeout=timeout)
    if check and r.returncode != 0:
        raise RuntimeError(f'adb {" ".join(args)}: {r.stdout} {r.stderr}')
    return r.stdout + r.stderr


def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()[:16]


def install(apk, fresh):
    marker = os.path.join(SUITE, 'installed.txt')
    want = digest(apk)
    have = open(marker).read().strip() if os.path.exists(marker) else ''
    if fresh:
        adb('uninstall', PKG)
        have = ''
    if have != want:
        print('installing', apk, adb('install', '-r', '-g' if not fresh else '-r', apk, timeout=300).strip().splitlines()[-1], flush=True)
        open(marker, 'w').write(want)
    if not fresh:
        for p in PERMS:
            adb('shell', 'pm', 'grant', PKG, f'android.permission.{p}')


RUNLEDGER = os.environ.get('RUNLEDGER')
ROUNDS = int(os.environ.get('ROUNDS', '1'))


def ledger_config(tag):
    return f'emu-{tag or "full"}'


def pending(test, tag):
    if not RUNLEDGER or os.environ.get('FORCE') == '1':
        return True
    r = subprocess.run([sys.executable, '-I', RUNLEDGER, 'need', os.environ['LEDGER'], os.environ['SOURCE_KEY'],
                        ledger_config(tag), str(ROUNDS), test], capture_output=True, text=True, check=True)
    if r.stderr.strip():
        print(r.stderr.strip(), flush=True)
    return bool(r.stdout.strip())


def record(test, tag, ok, out, seconds):
    if not RUNLEDGER:
        return
    case = os.path.join(out, 'case.txt')
    open(case, 'w').write(f'CASE case={test} ok={"true" if ok else "false"}\n')
    force = f'; FORCE: {os.environ.get("REASON", "")}' if os.environ.get('FORCE') == '1' else ''
    question = f'{os.environ.get("Q", "")} [{ledger_config(tag)}{force}; {int(seconds)}s]'
    subprocess.run([sys.executable, '-I', RUNLEDGER, 'record', os.environ['LEDGER'], os.environ['SOURCE_KEY'],
                    ledger_config(tag), case, question], check=True)


def run_one(test, tag, timeout):
    cls, _, method = test.partition('#')
    name = (method or cls) + (f'-{tag}' if tag else '')
    out = os.path.join(SUITE, 'runs', f'{name}-{time.strftime("%H%M%S")}')
    os.makedirs(os.path.join(out, 'evidence'), exist_ok=True)
    files = f'/sdcard/Android/data/{TEST_PKG}/files'
    adb('shell', 'rm', '-rf', files + '/*')
    lc = subprocess.Popen(['adb', 'logcat', '-v', 'epoch', '-T', '1'], stdout=open(os.path.join(out, 'logcat.txt'), 'w'), stderr=subprocess.STDOUT)
    started = time.time()
    cmd = ['adb', 'shell', 'am', 'instrument', '-w', '-r', '-e', 'class', f'{TEST_PKG}.{test}',
           '-e', 'pkg', PKG, '-e', 'hostPort', os.environ['HOSTD_PORT'], '-e', 'mode', tag or 'full',
           '-e', 'dest', os.environ.get('SW_TEST_DESTINATION', '/private/rn-device-test')]
    extra = os.environ.get('INST_ARGS', '').split()
    for k, v in zip(extra[::2], extra[1::2]):
        cmd += ['-e', k, v]
    cmd.append(RUNNER)
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        inst = r.stdout + r.stderr
    except subprocess.TimeoutExpired as e:
        inst = (e.stdout or b'').decode() if isinstance(e.stdout, bytes) else (e.stdout or '')
        inst += f'\nHOST TIMEOUT after {timeout} s'
        adb('shell', 'am', 'force-stop', TEST_PKG)
    finally:
        time.sleep(2)
        lc.terminate()
        lc.wait(timeout=10)
    open(os.path.join(out, 'instrument.txt'), 'w').write(inst)
    adb('pull', files + '/.', os.path.join(out, 'evidence'), timeout=120)
    ok = 'OK (1 test)' in inst
    failure = ''
    if not ok:
        for line in inst.splitlines():
            if line.startswith('INSTRUMENTATION_STATUS: stack=') or 'AssertionError' in line or 'Exception' in line:
                failure = line.replace('INSTRUMENTATION_STATUS: stack=', '')[:500]
                break
        if not failure:
            failure = inst.strip().splitlines()[-1][:500] if inst.strip() else 'no output'
    sw = sweep.sweep(quiet=True)
    report = legs.report(out, started, time.time())
    open(os.path.join(out, 'legs.txt'), 'w').write(report)
    result = f'{test} {"PASS" if ok else "FAIL"} {failure}\n{sw}\n'
    open(os.path.join(out, 'result.txt'), 'w').write(result)
    print(('PASS ' if ok else 'FAIL ') + test + (' :: ' + failure if failure else ''), '->', out, flush=True)
    print(sw, flush=True)
    record(test, tag, ok, out, time.time() - started)
    return ok, out


def main():
    args = sys.argv[1:]
    apk = fresh = tag = None
    timeout = 300
    tests = []
    i = 0
    while i < len(args):
        a = args[i]
        if a == '--apk':
            apk = args[i + 1]; i += 2; continue
        if a == '--fresh':
            fresh = True; i += 1; continue
        if a == '--tag':
            tag = args[i + 1]; i += 2; continue
        if a == '--timeout':
            timeout = int(args[i + 1]); i += 2; continue
        tests.append(a); i += 1
    tests = [t for t in tests if pending(t, tag)]
    if not tests:
        sys.exit(0)
    if apk:
        install(apk, bool(fresh))
    results = [run_one(t, tag, timeout) for t in tests for _ in range(ROUNDS if RUNLEDGER else 1)]
    sys.exit(0 if all(ok for ok, _ in results) else 1)


if __name__ == '__main__':
    main()
