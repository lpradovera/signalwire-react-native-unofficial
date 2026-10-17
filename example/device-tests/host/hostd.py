"""The host side of the Android device suite.

One HTTP server on 127.0.0.1 (the emulator reaches it as 10.0.2.2):

  /token          the app's token URL: proxied to the example token server,
                  or refused with 401 while the mode is 'refuse'
  /mode?token=    ok | refuse
  /tokenlog       the /token requests so far (time, status)
  /inbound?name=  places a call to the app's subscriber by REST; {status, id}
  /call?id=       one call's REST log: status, packets in (from the app) / out
  /live           this run's live test calls
  /newest         the newest test call
  /end?id=        ends a call by REST
  /emu?cmd=       an emulator console command (only `sensor set proximity N`)

and a watchdog thread that ends any test call older than CALL_CAP seconds,
polling every 2 s.

Environment: SW_ENV_FILE (SIGNALWIRE_* credentials), HOSTD_PORT, TOKEN_UPSTREAM
(http://127.0.0.1:<server port>), SW_SUBSCRIBER (/private/rn-example),
SW_INBOUND_URL (the SWML the inbound caller runs on answer), SW_MATCH (comma
separated to/from substrings of test calls), SINCE (ISO UTC), ANDROID_SERIAL,
RUN_DIR (logs), CALL_CAP (default 55).
"""
import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import swrest  # noqa: E402

RUN_DIR = os.environ['RUN_DIR']
os.makedirs(RUN_DIR, exist_ok=True)
REST = swrest.Rest(os.environ['SW_ENV_FILE'], os.environ['SINCE'], os.environ.get('SW_MATCH', 'rn-device-test,rn-example').split(','))
UPSTREAM = os.environ['TOKEN_UPSTREAM']
SUBSCRIBER = os.environ.get('SW_SUBSCRIBER', '/private/rn-example')
INBOUND_URL = os.environ['SW_INBOUND_URL']
CAP = float(os.environ.get('CALL_CAP', '55'))
SERIAL = os.environ.get('ANDROID_SERIAL', '')
STATE = {'token': 'ok'}
TOKENS = []
LOCK = threading.Lock()


def log(name, line):
    with LOCK, open(os.path.join(RUN_DIR, name), 'a') as f:
        f.write(f'{time.time():.3f} {time.strftime("%H:%M:%S")} {line}\n')


def watchdog(stop):
    while not stop.is_set():
        try:
            for x in REST.mine(pages=1):
                if x['status'] not in swrest.DONE and swrest.age(x) > CAP:
                    log('watchdog.log', f'ENDED {x["id"]} age={int(swrest.age(x))} -> {REST.end(x["id"])}')
        except Exception as e:  # keep watching; record why a poll failed
            log('watchdog.log', f'poll error {e!r}')
        stop.wait(2)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        log('hostd.log', fmt % args)

    def reply(self, code, body, ctype='application/json'):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def token(self):
        length = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(length) if length else None
        if STATE['token'] == 'refuse':
            TOKENS.append((time.time(), 401))
            log('token.log', f'{self.command} /token -> 401 (refuse mode)')
            return self.reply(401, {'error': 'Unauthorized'})
        req = urllib.request.Request(UPSTREAM + self.path, data=body, method=self.command,
                                     headers={k: v for k, v in self.headers.items() if k.lower() in ('content-type', 'authorization', 'accept')})
        try:
            with urllib.request.urlopen(req, timeout=20) as f:
                code, data, ctype = f.status, f.read(), f.headers.get('Content-Type', 'application/json')
        except urllib.error.HTTPError as e:
            code, data, ctype = e.code, e.read(), e.headers.get('Content-Type', 'application/json')
        except Exception as e:
            code, data, ctype = 502, json.dumps({'error': str(e)}).encode(), 'application/json'
        TOKENS.append((time.time(), code))
        expires = ''
        try:
            expires = json.loads(data).get('expires_at', '')
        except Exception:
            pass
        log('token.log', f'{self.command} /token -> {code} expires_at={expires}')
        self.reply(code, data, ctype)

    def do_POST(self):
        if urllib.parse.urlparse(self.path).path == '/token':
            return self.token()
        self.reply(404, {'error': 'not found'})

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        p = u.path
        if p == '/token':
            return self.token()
        if p == '/mode':
            STATE['token'] = q.get('token', 'ok')
            log('hostd.log', f'token mode {STATE["token"]}')
            return self.reply(200, STATE)
        if p == '/tokenlog':
            return self.reply(200, [{'t': t, 'status': s} for t, s in TOKENS])
        if p == '/inbound':
            s, cid = REST.dial_in(SUBSCRIBER, INBOUND_URL, q.get('name', 'rn-device-caller'))
            log('calls.log', f'INBOUND placed name={q.get("name")} -> {s} {cid}')
            return self.reply(200, {'status': s, 'id': cid})
        if p == '/call':
            x = REST.call(q['id'])
            return self.reply(200 if x else 404, swrest.summary(x) if x else {'error': 'not found'})
        if p == '/live':
            return self.reply(200, [swrest.summary(x) for x in REST.mine(pages=1) if x['status'] not in swrest.DONE])
        if p == '/newest':
            m = REST.mine(pages=1)
            return self.reply(200, swrest.summary(m[0]) if m else {})
        if p == '/end':
            code = REST.end(q['id'])
            log('calls.log', f'END by test {q["id"]} -> {code}')
            return self.reply(200, {'status': code})
        if p == '/emu':
            cmd = q.get('cmd', '')
            parts = cmd.split()
            if len(parts) == 4 and parts[:3] == ['sensor', 'set', 'proximity'] and parts[3].replace('.', '', 1).isdigit():
                r = subprocess.run(['adb', '-s', SERIAL, 'emu'] + parts, capture_output=True, text=True, timeout=20)
                log('hostd.log', f'emu {cmd} -> {r.returncode} {r.stdout.strip()} {r.stderr.strip()}')
                return self.reply(200, {'rc': r.returncode, 'out': r.stdout.strip(), 'err': r.stderr.strip()})
            return self.reply(400, {'error': 'command not allowed'})
        if p == '/ping':
            return self.reply(200, {'ok': True})
        self.reply(404, {'error': 'not found'})


def main():
    stop = threading.Event()
    threading.Thread(target=watchdog, args=(stop,), daemon=True).start()
    srv = ThreadingHTTPServer(('127.0.0.1', int(os.environ['HOSTD_PORT'])), Handler)
    with open(os.path.join(RUN_DIR, 'hostd.pid'), 'w') as f:
        f.write(str(os.getpid()))
    log('hostd.log', f'listening on {srv.server_address}')
    try:
        srv.serve_forever()
    finally:
        stop.set()


if __name__ == '__main__':
    main()
