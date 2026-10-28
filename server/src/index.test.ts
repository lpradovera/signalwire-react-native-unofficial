import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import type { Server } from 'node:net';

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// Scratch under the package's own gitignored .data/, never a machine-wide temp.
await mkdir(join(serverRoot, '.data'), { recursive: true });
const scratch = await mkdtemp(join(serverRoot, '.data', 'index-test-'));
after(() => rm(scratch, { recursive: true, force: true }));

describe('server entry point', () => {
  it('exits non-zero and says why when its port is taken (sweep-ops-3)', async () => {
    // Express 5 hands app.listen's callback the error; ignoring it logged
    // "Listening" and exited 0 with nothing printed.
    const squatter: Server = createServer();
    await new Promise<void>((resolve) => squatter.listen(0, resolve));
    const address = squatter.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    try {
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
        cwd: serverRoot,
        env: {
          PATH: process.env.PATH,
          PORT: String(port),
          DEVICE_STORE_PATH: join(scratch, 'devices.json')
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
      const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
      const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
      clearTimeout(timer);

      assert.notEqual(code, 0, output);
      assert.notEqual(code, null, `killed: it neither failed nor exited\n${output}`);
      assert.match(output, /EADDRINUSE/);
      assert.doesNotMatch(output, /"message":"Listening"/);
    } finally {
      squatter.close();
    }
  });
});
