import { test, expect } from '@playwright/test';
import { nudgeStep, dueNudgeStep, NUDGE_DAY_MS as D, NUDGE_HOUR_MS as H } from '../server/reportNudge.ts';

test.describe('open-report nudges', () => {
  test('steps: 24 h, 48 h, 5 days, then every day from day 7', () => {
    expect(nudgeStep(23 * H)).toBe(0);
    expect(nudgeStep(24 * H)).toBe(1);
    expect(nudgeStep(47 * H)).toBe(1);
    expect(nudgeStep(2 * D)).toBe(2);
    expect(nudgeStep(4.9 * D)).toBe(2);
    expect(nudgeStep(5 * D)).toBe(5);
    expect(nudgeStep(6.9 * D)).toBe(5);
    expect(nudgeStep(7 * D)).toBe(7);
    expect(nudgeStep(8.2 * D)).toBe(8);
    expect(nudgeStep(20 * D)).toBe(20);
  });

  test('a step is mailed once, and a late run mails only the latest', () => {
    expect(dueNudgeStep(25 * H, 0)).toBe(1);
    expect(dueNudgeStep(26 * H, 1)).toBe(0);
    expect(dueNudgeStep(3 * D, 1)).toBe(2);
    expect(dueNudgeStep(6 * D, 1)).toBe(5); // 48 h run was missed: no catch-up mail
    expect(dueNudgeStep(9 * D, 5)).toBe(9);
    expect(dueNudgeStep(9.5 * D, 9)).toBe(0);
    expect(dueNudgeStep(10 * D, 9)).toBe(10);
  });

  test('stops after the cap, and on a bad age', () => {
    expect(nudgeStep(61 * D)).toBe(0);
    expect(nudgeStep(Number.NaN)).toBe(0);
    expect(nudgeStep(-D)).toBe(0);
  });
});
