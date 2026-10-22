import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A deploy and a crash used to read the same in the log: a "startup" line with
 * nothing before it. The log audit of 22.10.2026 had to take fifty API
 * restarts on trust. Now a stop signal writes one api.shutdown line — and it
 * must land in the file, so it has to be written before the flush that
 * precedes the exit, and the exit has to still happen.
 *
 * Runs the real logstore in a child process (tsx, as the container does), with
 * its log directory in a temp folder.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SIGNUM = { SIGINT: 2, SIGTERM: 15 } as const;

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  test(`${signal} leaves an api.shutdown line in the log file, then exits by the signal`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'api-shutdown-'));
    try {
      const script = join(dir, 'hold.ts');
      writeFileSync(script, [
        `import { log } from ${JSON.stringify(join(ROOT, 'server', 'logstore.ts'))};`,
        `log.info('startup', 'test process up');`,
        `process.stdout.write('ready\\n');`,
        'setInterval(() => {}, 1000);',
      ].join('\n'));
      const child = spawn(join(ROOT, 'node_modules', '.bin', 'tsx'), [script], {
        env: { ...process.env, LOG_DIR: join(dir, 'logs'), LOG_TO_FILE: '1', LOG_LEVEL: 'info' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      await new Promise<void>((resolve, reject) => {
        child.stdout.on('data', (b: Buffer) => { if (b.toString().includes('ready')) resolve(); });
        child.on('exit', () => reject(new Error('exited before it was ready')));
      });
      const exited = new Promise<{ code: number | null; sig: NodeJS.Signals | null }>((resolve) =>
        child.on('exit', (code, sig) => resolve({ code, sig })));
      child.kill(signal);
      // The default action, re-raised after the flush: not a hang, not exit 0.
      // tsx's launcher reports its child's death by signal as exit 128+n.
      const { code, sig } = await exited;
      expect(sig === signal || code === 128 + SIGNUM[signal], `exit code ${code}, signal ${sig}`).toBe(true);

      const files = readdirSync(join(dir, 'logs')).filter((n) => n.endsWith('.jsonl'));
      const lines = files.flatMap((f) => readFileSync(join(dir, 'logs', f), 'utf8').trim().split('\n')).map((l) => JSON.parse(l));
      const last = lines[lines.length - 1];
      expect(last).toMatchObject({ evt: 'api.shutdown', lvl: 'info', data: { signal } });
      expect(lines.map((l) => l.evt)).toEqual(['startup', 'api.shutdown']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
