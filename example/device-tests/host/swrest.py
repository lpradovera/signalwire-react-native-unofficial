"""SignalWire REST for the device suite. Credentials come from an env file
(SIGNALWIRE_SPACE, SIGNALWIRE_PROJECT_ID, SIGNALWIRE_API_TOKEN), the same
file the example token server reads; nothing here prints them."""
import base64
import datetime
import json
import os
import urllib.error
import urllib.request

DONE = ('ended', 'completed', 'failed', 'busy', 'no-answer', 'canceled')


def load_env(path):
    values = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                values[k.strip()] = v.strip().strip('"').strip("'")
    return values


class Rest:
    def __init__(self, env_file, since, match):
        env = load_env(env_file)
        self.space = env['SIGNALWIRE_SPACE']
        self.project = env['SIGNALWIRE_PROJECT_ID']
        token = env['SIGNALWIRE_API_TOKEN']
        self._auth = 'Basic ' + base64.b64encode(f'{self.project}:{token}'.encode()).decode()
        self.since = since  # ISO UTC; only calls created after it are the suite's
        self.match = match  # substrings of to/from that mark a test call

    def req(self, method, path, body=None):
        r = urllib.request.Request(
            f'https://{self.space}{path}', method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={'Authorization': self._auth, 'Content-Type': 'application/json', 'Accept': 'application/json'})
        try:
            with urllib.request.urlopen(r, timeout=20) as f:
                t = f.read()
                return f.status, (json.loads(t) if t else None)
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode()[:500]
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            return 599, str(e)

    def mine(self, pages=3):
        """This run's test calls, newest first."""
        out, page = [], '/api/voice/logs?page_size=50'
        for _ in range(pages):
            s, d = self.req('GET', page)
            if s != 200 or not isinstance(d, dict):
                break
            stop = False
            for x in d.get('data', []):
                if x['created_at'] < self.since:
                    stop = True
                    break
                where = (x.get('to') or '') + ' ' + (x.get('from') or '')
                if any(m in where for m in self.match):
                    out.append(x)
            nxt = (d.get('links') or {}).get('next')
            if stop or not nxt:
                break
            page = nxt.split('.signalwire.com', 1)[1]
        return out

    def call(self, cid):
        s, d = self.req('GET', f'/api/voice/logs/{cid}')
        return d if s == 200 and isinstance(d, dict) else None

    def end(self, cid):
        return self.req('POST', '/api/calling/calls',
                        {'command': 'calling.end', 'id': cid, 'params': {'reason': 'hangup'}})[0]

    def dial_in(self, to, swml_url, caller_id, timeout=30, max_duration=60):
        s, d = self.req('POST', '/api/calling/calls', {'command': 'dial', 'params': {
            'from': f'sip:rn-device-caller@{self.space}', 'to': to, 'caller_id': caller_id,
            'url': swml_url, 'timeout': timeout, 'max_duration': max_duration}})
        return s, (d.get('id') if isinstance(d, dict) else d)

    def laml_in_progress(self):
        s, d = self.req('GET', f'/api/laml/2010-04-01/Accounts/{self.project}/Calls.json?Status=in-progress')
        return s, (len(d.get('calls', [])) if isinstance(d, dict) else None)


def age(x):
    created = datetime.datetime.fromisoformat(x['created_at'].replace('Z', '+00:00'))
    return (datetime.datetime.now(datetime.timezone.utc) - created).total_seconds()


def qos(x):
    q = x.get('qos_metrics') or {}
    return q.get('audio_in_media_packet_count'), q.get('audio_out_media_packet_count')


def summary(x):
    i, o = qos(x)
    return {'id': x['id'], 'status': x.get('status'), 'created_at': x.get('created_at'),
            'age': round(age(x), 1), 'duration': x.get('duration'), 'direction': x.get('direction'),
            'from': x.get('from'), 'to': x.get('to'), 'in_pkts': i, 'out_pkts': o,
            'billing_ms': x.get('billing_ms')}
