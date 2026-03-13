# Email Feedback on Save — Design Spec

## Overview

When a referee coach clicks "Save to Database", the system saves the feedback, generates and stores the PDF, sends an email to the coachee with the PDF attached, and closes the game/feedback for further edits (unless a second observation is flagged).

## Architecture

Single enhanced endpoint approach: extend the existing `POST /api/feedback/submit` to handle PDF storage and email sending in one request. Feedback is saved first (priority), email is best-effort after.

## Client-Side Changes

### Modified request payload

`saveFeedbackToPocketBase` sends additional fields and returns a response object (breaking change from current `Promise<void>`):

```ts
// Request
{
  gameId: string;
  role: '1. SR' | '2. SR';
  formData: FeedbackFormData;
  pdfBase64: string;       // PDF blob as base64
  pdfFilename: string;     // e.g. "12345-1SR.pdf"
  tipsAndTricks: string;   // tips text (email-only, NOT persisted in feedback record)
}

// Response
{
  id: string;
  emailSent: boolean;
  emailError?: string;
  emailWarning?: string;  // e.g. "RC has no email, sent without CC"
}
```

### PDF generation before save

Extract the PDF generation logic from `handleDownloadPdf` into a shared helper. Before calling the API, generate the PDF blob client-side using the existing `html-to-image` + `jsPDF` pipeline, convert to base64, and include in the request.

The email PDF path uses `pixelRatio: 1.5` (vs `2` for the download-only path) to keep file sizes manageable for email attachments. The manual "Download PDF" button retains `pixelRatio: 2` for higher quality.

### Response handling

Client shows localized status messages:
- `emailSent: true` → "Feedback saved and email sent" / "Feedback gespeichert und E-Mail gesendet"
- `emailSent: false` → "Feedback saved, but email failed: {reason}"

### Form locking

New state: `feedbackLocked: boolean` (default `false`).

After successful save, if `formData.results.secondBesuch !== 'Y'`:
- Set `feedbackLocked = true`
- Disable all form inputs
- Hide save button
- Show a read-only banner: "Feedback submitted" / "Feedback eingereicht"

Reset `feedbackLocked` when:
- User clicks Reset
- User selects a new game/coachee

### Confirmation dialog

The existing confirmation modal (triggered by `showConfirmModal === 'save'`) should show the recipient email address before sending. Update the modal text to include: "An email with the feedback PDF will be sent to {coacheeEmail}."

## Server-Side Changes

### New dependency

```
npm install nodemailer
npm install --save-dev @types/nodemailer
```

### New environment variables

```env
# SMTP (Migadu) — required for feedback email sending
SMTP_HOST=smtp.migadu.com
SMTP_PORT=465
SMTP_USER=<migadu-login-email>
SMTP_PASS=<migadu-password>
SMTP_FROM=coaching-feedback@svrz.ch

# Feedback email settings
FEEDBACK_CC=rc_coaching@volleyball.lucanepa.com
FEEDBACK_SURVEY_URL=https://docs.google.com/forms/d/e/1FAIpQLSe-UY2EknI02mkGwoPlFso9pcigGV5ceSt2Q3CKJaT6PQzzpA/viewform

# Test mode: set to 1 to redirect ALL emails to FEEDBACK_TEST_RECIPIENT instead of real recipients.
# Set to 0 (or remove) for production. Subject line is prefixed with [TEST] in test mode.
FEEDBACK_EMAIL_TEST=1
FEEDBACK_TEST_RECIPIENT=luca.canepa@gmail.com
```

### Express body limit

Increase from `2mb` to `8mb` to accommodate base64 PDF (a 3MB binary becomes ~4MB in base64, plus JSON payload overhead):

```ts
app.use(express.json({ limit: '8mb' });
```

### SMTP transport setup

Create a reusable Nodemailer transport at module level. Warn at startup if not configured; email sends will fail at runtime with a clear error.

```ts
import nodemailer from 'nodemailer';

const smtpTransport = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.migadu.com',
  port: Number(process.env.SMTP_PORT || 465),
  secure: Number(process.env.SMTP_PORT || 465) === 465,
  auth: {
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
  },
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
});

if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
  console.warn('[startup] SMTP not fully configured. Feedback email sending will fail at runtime.');
}
```

### PocketBase schema changes

The following fields need to be added to existing PocketBase collections:

1. **`games` collection** — Add `feedback_closed_roles` field (JSON type, default `[]`). Stores an array of role strings (e.g. `["1. SR"]`) that have been closed for this game.

2. **`referee_coach_feedbacks` collection** — Add `pdf_file` field (File type, single file, max 5MB). Stores the feedback PDF attachment.

3. **`referee_coaches` (people) collection** — This is the people table (with `first_name`/`last_name` fields), resolved via `collectionCandidates.refereeCoachPeople` in code. Verify `email` field exists. If not, add it (Text type, optional).

4. **`coachees` collection** — Verify `email` field exists (it does per the existing `Coachee` type, but confirm in PB admin).

These are manual PocketBase admin changes (no migration script needed).

### Enhanced `POST /api/feedback/submit`

The endpoint follows a strict validation-then-mutation order. The save button is disabled client-side during the API call (`isSaving` state) to prevent duplicate submissions.

**Phase 1 — Validation (reject before any mutations):**

1. **Validate inputs** — Ensure `gameId`, `role`, `formData`, `pdfBase64` are present.
2. **Validate PDF size** — Decode `pdfBase64` and reject with 400 if decoded size exceeds 3MB.
3. **Check game+role not already closed** — Read the game record's `feedback_closed_roles` JSON field. If the assessed `role` is already present, reject with 409 Conflict.
4. **Validate coachee email** — Fetch `coachee.email`. If missing/empty, reject with 400 ("Coachee has no email address. Add an email in the admin panel before submitting feedback.").

**Phase 2 — Save (existing logic + PDF upload):**

5. **Save feedback record** — Create the feedback record, update coachee, create observation (existing logic). Returns HTTP 201.
6. **Upload PDF to feedback record** — Upload the decoded PDF as a file to the `pdf_file` field on the created feedback record using PocketBase's FormData upload API.

**Phase 3 — Email (best-effort, failures do not roll back save):**

7. **Resolve RC email** — Using the already-resolved `refereeCoachPersonId`, re-fetch the full person record from PocketBase using the existing `withCollection(collectionCandidates.refereeCoachPeople, ...)` pattern with `getOne(refereeCoachPersonId)` to read their `email` field. If missing, set `emailWarning: "RC has no email, sent without RC in CC"` and omit from CC/Reply-To.
8. **Build and send email:**
   - From: `SMTP_FROM`
   - Reply-To: RC person email (if available)
   - To: coachee email
   - CC: [RC email (if available), FEEDBACK_CC]
   - Subject (localized based on `formData.lang`):
     - EN: `"Referee Coaching Feedback – Match {matchNo} ({dd.MM.yyyy})"` (matchNo from `game.match_no`)
     - DE: `"SR-Coaching Feedback – Spiel {matchNo} ({dd.MM.yyyy})"`
   - Body: HTML email (see Email Template section). All user-provided strings (coachee name, team names, tipsAndTricks, etc.) must be HTML-escaped before insertion.
   - Plain text fallback: manually constructed text version (match info as key:value lines, tips as plain text, survey URL as raw link). Nodemailer does not auto-generate plain text from HTML.
   - Attachment: PDF file from decoded base64 buffer
   - `tipsAndTricks` is included in the email body only — it is NOT stored in PocketBase

**Phase 4 — Closure:**

9. **Mark game as closed** — If `secondBesuch !== 'Y'` (note: empty string `''` defaults to closure — this is intentional since the default state means "no second visit needed"), read-then-append the assessed role to the game's `feedback_closed_roles` JSON array and update the record. Low concurrency risk given single-RC-per-game usage pattern.

**Phase 5 — Response:**

10. **Return response** (HTTP 201):
    ```json
    {
      "id": "<feedback-record-id>",
      "emailSent": true,
      "emailError": null,
      "emailWarning": null
    }
    ```

### Error handling

| Scenario | Behavior |
|----------|----------|
| Coachee has no email | **Reject with 400** before saving — coachee email is required |
| RC has no email | Email sent without RC in CC, `emailWarning` set |
| SMTP credentials missing | Warn at startup; email send fails at runtime, `emailSent: false` with `emailError` |
| SMTP send fails | Save already succeeded, `emailSent: false`, `emailError` with reason |
| Game+role already closed | **Reject with 409** Conflict before saving; also prevent in UI (see below) |
| PDF base64 > 3MB decoded | **Reject with 400** before processing (3MB binary ≈ 4MB base64, within 8MB body limit) |

### Closed game prevention in UI

When a game+role is already closed:
- The save button is disabled
- A banner shows "This game has already been observed for this role" / "Dieses Spiel wurde für diese Rolle bereits beobachtet"
- The eligible games list can optionally badge closed games
- The server checks `feedback_closed_roles` on the game record as a safety net and rejects with 409

Note: The eligible games endpoint (`GET /api/eligible-games`) must include the `feedback_closed_roles` field. This requires adding it to the PocketBase `fields` query parameter in `getEligibleGames` (currently an explicit field list) and mapping it into the response object.

## Email Template

HTML email with a light background (`#f5f5f4` stone-100) and white card container. Primarily English body text, with subject line following `formData.lang`.

### Structure

1. **Header** — "Referee Coaching Feedback" title (text-only for maximum email client compatibility)

2. **Match summary table** — Clean two-column layout:
   - Match No. / League / Date (formatted as `dd.MM.yyyy` Swiss convention) / Location
   - Teams (Home vs Away)
   - Role assessed (1. SR / 2. SR)
   - Referee Coach name

3. **Tips & Tricks section** (conditional — only if `tipsAndTricks` is non-empty):
   - Highlighted block with a left border accent (emerald)
   - Header: "Tips & Tricks"
   - Content: the tips text, preserving line breaks (`white-space: pre-wrap`)

4. **Feedback survey link:**
   - "We value your feedback on the coaching experience:"
   - Styled link/button to the Google Forms URL (`FEEDBACK_SURVEY_URL`)

5. **Footer:**
   - "The complete coaching feedback report is attached as a PDF."
   - Small text: "This email was sent automatically by the SR-Coaching system."

### Style notes

- Background: `#f5f5f4` (stone-100)
- Card: `#ffffff` with subtle border, rounded corners (via padding, email-safe)
- Accent color: `#059669` (emerald-600, matching the save button)
- Font: system font stack, 14px base
- All styling inline (email client compatibility)
- Plain text fallback: manually constructed (Nodemailer does not auto-generate from HTML)

### Data flow: `tipsAndTricks`

The `tipsAndTricks` field is **email-only**. It is:
- Sent from client to server in the request payload
- Included in the email body (Tips & Tricks section)
- **NOT stored** in PocketBase or any persistent storage
- This matches the existing UI text: "These tips will not be saved in the official feedback, but will be sent to the referee via email only."

## Files Modified

| File | Changes |
|------|---------|
| `server/index.ts` | Add nodemailer import, SMTP transport, email builder function, enhance `/api/feedback/submit` with PDF upload + email + closure, increase body limit, add `feedback_closed_roles` to eligible games response |
| `src/App.tsx` | Extract PDF generation helper, modify `handleSaveFeedback` to generate PDF and send with request, add `feedbackLocked` state, add locked UI banner, update confirmation modal with recipient email, handle closure status |
| `src/lib/pocketbase.ts` | Update `saveFeedbackToPocketBase` params and return type (breaking change from `Promise<void>` to `Promise<{id, emailSent, ...}>`) |
| `src/types.ts` | Add `feedbackClosedRoles?: string[]` to `EligibleGame` type |
| `package.json` | Add `nodemailer` dependency |
| `.env.example` | Add SMTP and feedback email env vars |

## New dependency

- `nodemailer` (MIT license, no native dependencies, widely used)
- `@types/nodemailer` (dev only)

## Decisions log

- **Single endpoint** over separate save+email endpoints — simpler, one UX flow
- **Client-side PDF** sent to server over server-side rendering — reuses existing pixel-perfect PDF, avoids headless browser dependency
- **Save-first, email-second** — feedback data is never lost even if email fails
- **Nodemailer + Migadu SMTP** — Migadu allows custom From header for domain-verified addresses
- **Form locking (UI + backend)** — unless `secondBesuch === 'Y'`, game is closed for that role after save
- **Reply-To set to RC email** — coachee replies go to their referee coach
- **Email primarily English** — subject follows form lang (DE/EN), body prose in English
- **tipsAndTricks email-only** — not persisted, matches existing UI expectation
- **Coachee email required** — reject submission if missing, not graceful degradation
- **PDF stored as PB file field** — not base64 in JSON, proper file storage
- **Date format in subject** — Swiss convention `dd.MM.yyyy` for both DE and EN
