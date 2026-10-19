import { test, expect } from '@playwright/test';
import { parkVerdict, tombstoneTime, rolesToRemove, parseGameIds } from '../server/parkSync';

// The server's half of keeping one coach's devices agreeing about a parked
// draft, without a database: which park wins, what a removal leaves behind.

const DAY = 24 * 60 * 60 * 1000;

test.describe('A park', () => {
  test('writes when nothing is stored, or nothing newer', () => {
    expect(parkVerdict(null, 100)).toBe('write');
    expect(parkVerdict({ updatedAt: 100, deleted: false }, 200)).toBe('write');
    // The same copy parked again — on every signature, on every page hide.
    expect(parkVerdict({ updatedAt: 100, deleted: false }, 100)).toBe('write');
  });

  test('never writes an older copy over a newer one from another device', () => {
    // The phone nobody touched again, hidden after the laptop's evening of work.
    expect(parkVerdict({ updatedAt: 200, deleted: false }, 100)).toBe('stale');
  });

  test('does not bring back work that was sent or discarded after it', () => {
    expect(parkVerdict({ updatedAt: 200, deleted: true }, 100)).toBe('gone');
    expect(parkVerdict({ updatedAt: 200, deleted: true }, 200)).toBe('gone');
  });

  test('does bring back work edited after the removal', () => {
    expect(parkVerdict({ updatedAt: 200, deleted: true }, 201)).toBe('write');
  });
});

test.describe('A tombstone', () => {
  const now = Date.parse('2026-10-19T12:00:00Z');

  test('carries the removing device\'s clock', () => {
    expect(tombstoneTime(now - 5000, now - 1000, now, DAY)).toBe(now - 1000);
  });

  test('is never older than the copy it removes', () => {
    // A removing device whose clock runs behind the one that wrote the copy:
    // stamped with its own time, the copy would read as newer than its removal.
    expect(tombstoneTime(now - 1000, now - 5000, now, DAY)).toBe(now - 1000);
  });

  test('falls back to the server clock for a device clock it cannot believe', () => {
    expect(tombstoneTime(0, now + 2 * DAY, now, DAY)).toBe(now);
    expect(tombstoneTime(0, 'yesterday', now, DAY)).toBe(now);
    expect(tombstoneTime(0, undefined, now, DAY)).toBe(now);
    expect(tombstoneTime(0, -5, now, DAY)).toBe(now);
  });
});

test.describe('A removal', () => {
  test('names one role, or both', () => {
    expect(rolesToRemove('1. SR')).toEqual(['1. SR']);
    expect(rolesToRemove('2. SR')).toEqual(['2. SR']);
    expect(rolesToRemove('both')).toEqual(['1. SR', '2. SR']);
  });

  test('without a role is an older build, and leaves no tombstone', () => {
    // An older build asks this way after filing ONE half of a two-referee
    // visit, too: a tombstone on the other half would retire unsent work.
    expect(rolesToRemove(undefined)).toBeNull();
  });

  test('of a role that does not exist removes nothing', () => {
    expect(rolesToRemove('3. SR')).toEqual([]);
    expect(rolesToRemove('')).toEqual([]);
    expect(rolesToRemove(['1. SR', '2. SR'])).toEqual([]);
  });
});

test('the games a device asks about are bounded and cannot reach a filter', () => {
  expect(parseGameIds('g1,g2, g1 ,,g3')).toEqual(['g1', 'g2', 'g3']);
  expect(parseGameIds(['g1', 'g2'])).toEqual(['g1', 'g2']);
  expect(parseGameIds('g1" || rc_id != "')).toEqual([]);
  expect(parseGameIds(undefined)).toEqual([]);
  expect(parseGameIds(Array.from({ length: 60 }, (_, i) => `g${i}`).join(','))).toHaveLength(40);
});
