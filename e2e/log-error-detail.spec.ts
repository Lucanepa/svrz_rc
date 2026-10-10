import { test, expect } from '@playwright/test';
import { redact } from '../server/logstore';

// 10.10.2026: every "Notiz speichern" answered 500 and the log said only
// "Failed to update record." — PocketBase's reason (the season's president
// notes had outgrown a 5000-character text field) was in the error's
// response.data and never reached the log. It does now; the value never does.
test('a PocketBase refusal is logged with its status and per-field reason', () => {
  const error = Object.assign(new Error('Failed to update record.'), {
    name: 'ClientResponseError 400',
    status: 400,
    response: { data: { value: { code: 'validation_max_text_constraint', message: 'Must be no more than 5000 character(s).', params: { max: 5000 } } } },
  });
  const out = redact(error) as Record<string, unknown>;
  expect(out.message).toBe('Failed to update record.');
  expect(out.status).toBe(400);
  // The message and the limit are the diagnosis. `code` falls under the
  // secret-key redaction (it is built for one-time codes) and stays redacted.
  expect(out.data).toMatchObject({ value: { message: 'Must be no more than 5000 character(s).', params: { max: 5000 } } });
});

test('a plain error stays as it was', () => {
  const out = redact(new Error('boom')) as Record<string, unknown>;
  expect(Object.keys(out).sort()).toEqual(['message', 'name', 'stack']);
});
