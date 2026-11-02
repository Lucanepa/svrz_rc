import { test, expect } from '@playwright/test';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { isExpectedWarning, quietExpectedWarnings } from '../server/quietWarnings';

/**
 * The passkey library's first ceremony after a restart makes Node print two
 * ExperimentalWarnings about the Web Crypto API, through console.error — and
 * the server files console.error as an error and mails it (02.11.2026). Those
 * two are dropped; every other warning still reaches Node's own printer.
 */

const webCrypto = Object.assign(new Error('The ML-DSA-44 Web Crypto API algorithm is an experimental feature and might change at any time'), { name: 'ExperimentalWarning' });
const supports = Object.assign(new Error('The supports Web Crypto API method is an experimental feature and might change at any time'), { name: 'ExperimentalWarning' });
const other = Object.assign(new Error('Type Stripping is an experimental feature'), { name: 'ExperimentalWarning' });
const deprecation = Object.assign(new Error('Buffer() is deprecated'), { name: 'DeprecationWarning' });

test('only the Web Crypto experimental notices count as expected', () => {
  expect(isExpectedWarning(webCrypto)).toBe(true);
  expect(isExpectedWarning(supports)).toBe(true);
  expect(isExpectedWarning(other)).toBe(false);
  expect(isExpectedWarning(deprecation)).toBe(false);
  expect(isExpectedWarning(null)).toBe(false);
});

test('the filter sits in front of the handlers that were there', () => {
  const source = new EventEmitter();
  const seen: string[] = [];
  source.on('warning', (w: Error) => seen.push(w.message));
  quietExpectedWarnings(source as never);
  for (const w of [webCrypto, supports, other, deprecation]) source.emit('warning', w);
  expect(seen).toEqual([other.message, deprecation.message]);
});

test('in a real Node process the two notices are not printed, the rest are', () => {
  const module = resolve('server/quietWarnings.ts');
  const script = `
    const { quietExpectedWarnings } = await import(${JSON.stringify(module)});
    quietExpectedWarnings();
    process.emitWarning(${JSON.stringify(webCrypto.message)}, 'ExperimentalWarning');
    process.emitWarning(${JSON.stringify(supports.message)}, 'ExperimentalWarning');
    process.emitWarning('something else entirely', 'DeprecationWarning');
    await new Promise((r) => setTimeout(r, 50));
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  expect(run.status).toBe(0);
  const stderr = run.stderr;
  expect(stderr).not.toContain('Web Crypto API');
  expect(stderr).toContain('something else entirely');
});
