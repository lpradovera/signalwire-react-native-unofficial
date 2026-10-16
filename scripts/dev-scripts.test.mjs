// Tests for scripts/dev.sh, run in a scratch directory
// under the repository's .tmp/. dev.sh is sourced (which defines its functions
// without running them) and driven with listeners on ports the OS picks, so no
// service is started, no real port is touched, and tailscale is never asked
// to change anything. Every listener started here is closed by the test.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const devSh = join(repo, 'scripts', 'dev.sh');
const sandbox = join(repo, '.tmp', 'dev-scripts-test');

const hasLsof = spawnSync('lsof', ['-v']).error === undefined;

before(() => {
  rmSync(sandbox, { recursive: true, force: true });
  mkdirSync(sandbox, { recursive: true });
});
after(() => rmSync(sandbox, { recursive: true, force: true }));

/** Runs bash with dev.sh sourced; SW_HOST is set so tailscale is not consulted. */
function devShell(script, { cwd = sandbox, env = {} } = {}) {
  return spawnSync('bash', ['-c', `source "${devSh}"\n${script}`], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, SW_HOST: 'test-host', SW_SCRATCH: join(sandbox, 'logs'), ...env }
  });
}

/** A TCP listener in its own process, with `cwd` as its working directory. */
async function listener(cwd) {
  const child = spawn(
    process.execPath,
    ['-e', "const s=require('net').createServer().listen(0,'127.0.0.1',()=>console.log(s.address().port))"],
    { cwd, stdio: ['ignore', 'pipe', 'inherit'] }
  );
  const port = await new Promise((resolve, reject) => {
    child.stdout.once('data', (data) => resolve(Number(String(data).trim())));
    child.once('exit', (code) => reject(new Error(`listener exited ${code}`)));
  });
  return {
    port,
    pid: child.pid,
    alive: () => child.exitCode === null && child.signalCode === null,
    close: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once('exit', resolve);
        child.kill();
      })
  };
}

describe('dev.sh', () => {
  test('a relative SW_SCRATCH becomes absolute, so logs written after a cd land in it', () => {
    const elsewhere = join(sandbox, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    const result = spawnSync('bash', [devSh, 'status'], {
      cwd: elsewhere,
      encoding: 'utf8',
      env: { ...process.env, SW_HOST: 'test-host', SW_SCRATCH: '.dev' }
    });
    assert.equal(result.status, 0, result.stderr);
    const logs = result.stdout.trim().split('\n').at(-1);
    assert.equal(logs, join(elsewhere, '.dev'));
  });

  test('up exits with the status of its checks', () => {
    const stubs = 'start_server(){ :; }; start_funnel(){ :; }; start_metro(){ :; }; start_vite(){ :; }; funnel_up(){ return 1; }';
    assert.equal(devShell(`${stubs}; verify(){ return 1; }; main up`).status, 1);
    assert.equal(devShell(`${stubs}; verify(){ return 0; }; main up`).status, 0);
  });

  test('up warns that the funnel is public only when the funnel is up', () => {
    const stubs = 'start_server(){ :; }; start_funnel(){ :; }; start_metro(){ :; }; start_vite(){ :; }; verify(){ return 0; }';
    assert.doesNotMatch(devShell(`${stubs}; funnel_up(){ return 1; }; main up`).stdout, /publishes :3000/);
    assert.match(devShell(`${stubs}; funnel_up(){ return 0; }; main up`).stdout, /publishes :3000/);
  });

  test('the device-log hint uses log collect, which reads a device; log stream cannot', () => {
    const out = devShell('device_log_hint').stdout;
    assert.match(out, /sudo log collect --device-name '<iPad name>' --last 10m --output/);
    assert.match(out, /log show --archive .* --style compact > .*device-console\.log/);
    assert.doesNotMatch(out, /log stream/);
  });

  describe('a port held by another process', { skip: !hasLsof && 'needs lsof' }, () => {
    let foreign;
    let ours;
    const bin = join(sandbox, 'bin');
    const npxCalled = join(sandbox, 'npx-called');

    before(async () => {
      // A fake npx, first on PATH: if start_metro ever tried to start Metro
      // here, the marker would appear and no real Metro would run.
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, 'npx'), `#!/bin/sh\ntouch "${npxCalled}"\n`, { mode: 0o755 });
      foreign = await listener(sandbox);
      ours = await listener(join(repo, 'example'));
    });
    after(async () => {
      await foreign?.close();
      await ours?.close();
    });

    const env = () => ({ PATH: `${bin}:${process.env.PATH}` });

    test('start_metro reports it held and fails, rather than "already up", and starts nothing', () => {
      const result = devShell(`METRO_PORT=${foreign.port}; start_metro`, { env: env() });
      assert.equal(result.status, 1);
      assert.match(result.stdout, new RegExp(`metro :${foreign.port}  held by another process \\(pid ${foreign.pid}`));
      assert.doesNotMatch(result.stdout, /already up/);
      assert.equal(existsSync(npxCalled), false);
    });

    test("this checkout's own listener still counts as up", () => {
      const result = devShell(`METRO_PORT=${ours.port}; start_metro`, { env: env() });
      assert.equal(result.status, 0);
      assert.match(result.stdout, /already up/);
    });

    test('status says the port is held, not that the service is up', () => {
      const result = devShell(`VITE_PORT=${foreign.port}; METRO_PORT=${ours.port}; status`);
      assert.match(result.stdout, new RegExp(`vite \\(${foreign.port}\\) down — the port is held by another process: pid ${foreign.pid}`));
      assert.match(result.stdout, new RegExp(`metro \\(${ours.port}\\) up — pid ${ours.pid}`));
    });

    test('stop_port leaves a foreign listener running', () => {
      const result = devShell(`stop_port ${foreign.port} metro "$METRO_DIR"`);
      assert.match(result.stdout, /left alone/);
      assert.equal(foreign.alive(), true);
    });
  });
});
