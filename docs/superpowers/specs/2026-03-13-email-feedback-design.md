# Email Feedback on Save — Design Spec

## Overview

When a referee coach clicks "Save to Database", the system saves the feedback, generates and stores the PDF, sends an email to the coachee with the PDF attached, and closes the game/feedback for further edits (unless a second observation is flagged).

## Architecture

Single enhanced endpoint approach: extend the existing `POST /api/feedback/submit` to handle PDF storage and email sending in one request. Feedback is saved first (priority), email is best-effort after.

## Client-Side Changes

### Modified request payload

`saveFeedbackToPocketBase` sends additional fields:

```ts
{
  gameId: string;
  role: '1. SR' | '2. SR';
  formData: FeedbackFormData;
  pdfBase64: string;       // PDF blob as base64
  pdfFilename: string;     // e.g. "12345-1SR.pdf"
  tipsAndTricks: string;   // tips text from textarea
}
```

### PDF generation before save

Extract the PDF generation logic from `handleDownloadPdf` into a shared helper. Before calling the API, generate the PDF blob client-side using the existing `html-to-image` + `jsPDF` pipeline, convert to base64, and include in the request.

### Response handling

The server returns:

```ts
{
  id: string;
  emailSent: boolean;
  emailError?: string;
  emailWarning?: string;  // e.g. "RC has no email, sent without CC"
}
```

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

## Server-Side Changes

### New dependency

```
npm install nodemailer
npm install --save-dev @types/nodemailer
```

### New environment variables

```env
SMTP_HOST=smtp.migadu.com
SMTP_PORT=465
SMTP_USER=<migadu-login-email>
SMTP_PASS=<migadu-password>
SMTP_FROM=coaching-feedback@svrz.ch
FEEDBACK_CC=rc_coaching@volleyball.lucanepa.com
FEEDBACK_SURVEY_URL=https://docs.google.com/forms/d/e/1FAIpQLSe-UY2EknI02mkGwoPlFso9pcigGV5ceSt2Q3CKJaT6PQzzpA/viewform
```

### Express body limit

Increase from `2mb` to `6mb` to accommodate base64 PDF:

```ts
app.use(express.json({ limit: '6mb' }));
```

### SMTP transport setup

Create a reusable Nodemailer transport at module level:

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
});

// Warn at startup if SMTP is not configured
if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
  console.warn('[startup] SMTP not fully configured. Email sending will fail.');
}
```

### Enhanced `POST /api/feedback/submit`

After the existing save logic (feedback record, coachee update, observation), add:

1. **Store PDF on feedback record** — Upload `pdfBase64` as a file attachment to the created feedback record in PocketBase (if the collection supports file fields; otherwise store as a base64 JSON field `pdf_data`).

2. **Resolve email addresses:**
   - **To:** `coachee.email` — **required**. If missing, reject the entire submission with 400 ("Coachee has no email address"). Coachees must have an email configured before feedback can be submitted.
   - **CC (RC):** Fetch the RC person record using `refereeCoachPersonId`, read their `email` field. If missing, still send but add `emailWarning`.
   - **CC (fixed):** `FEEDBACK_CC` env var (`rc_coaching@volleyball.lucanepa.com`)
   - **Reply-To:** RC person's email (so coachee replies go to the RC)

3. **Build email:**
   - From: `SMTP_FROM`
   - Reply-To: RC person email
   - To: coachee email
   - CC: [RC email (if available), FEEDBACK_CC]
   - Subject: localized based on `formData.lang`
     - EN: `"Referee Coaching Feedback – Match {matchNo} ({date})"`
     - DE: `"SR-Coaching Feedback – Spiel {matchNo} ({date})"`
   - Body: HTML email with light background card layout (see Email Template section)
   - Attachment: PDF file from base64

4. **Mark game as closed:** If `secondBesuch !== 'Y'`, update the game record with `feedback_closed_roles` (array or JSON field) to track which role has been closed. On future submissions, check this field and reject with 409 if the role is already closed.

5. **Return response:**
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
| Coachee has no email | **Reject with 400** — coachee email is required for feedback submission |
| RC has no email | Email sent without RC in CC, `emailWarning` set |
| SMTP not configured | **Reject with 500** at startup — SMTP is required infrastructure, warn loudly on boot |
| SMTP send fails | Save already succeeded, `emailSent: false`, `emailError` with reason |
| Game+role already closed | **Reject with 409** Conflict before saving; also prevent in UI (see below) |
| PDF generation | Use `pixelRatio: 1.5` instead of `2` to keep PDFs well under size limits |

### Closed game prevention in UI

When a game+role is already closed:
- The save button is disabled
- A banner shows "This game has already been observed for this role"
- The eligible games list can optionally filter out or badge closed games
- The server checks `feedback_closed_roles` on the game record as a safety net and rejects with 409

## Email Template

HTML email with a light background (`#f5f5f4` stone-100) and white card container. Primarily English body text, with subject line following `formData.lang`.

### Structure

1. **Header** — "Referee Coaching Feedback" title, Swiss Volley logo (optional, can be text-only for email compatibility)

2. **Match summary table** — Clean two-column layout:
   - Match No. / League / Date / Location
   - Teams (Home vs Away)
   - Role assessed (1. SR / 2. SR)
   - Referee Coach name

3. **Tips & Tricks section** (conditional — only if `tipsAndTricks` is non-empty):
   - Highlighted block with a left border accent
   - Header: "Tips & Tricks"
   - Content: the tips text, preserving line breaks

4. **Feedback survey link:**
   - "We value your feedback on the coaching experience:"
   - Styled link/button to the Google Forms URL

5. **Footer:**
   - "The complete coaching feedback report is attached as a PDF."
   - Small text: "This email was sent automatically by the SR-Coaching system."

### Style notes

- Background: `#f5f5f4` (stone-100)
- Card: `#ffffff` with subtle border, rounded corners (via padding, email-safe)
- Accent color: `#059669` (emerald-600, matching the save button)
- Font: system font stack, 14px base
- All styling inline (email client compatibility)
- Plain text fallback included

## Files Modified

| File | Changes |
|------|---------|
| `server/index.ts` | Add nodemailer import, SMTP transport, email builder function, enhance `/api/feedback/submit` endpoint, increase body limit |
| `src/App.tsx` | Extract PDF generation helper, modify `handleSaveFeedback` to generate PDF and send with request, add `feedbackLocked` state, add locked UI banner |
| `src/lib/pocketbase.ts` | Update `saveFeedbackToPocketBase` params to include `pdfBase64`, `pdfFilename`, `tipsAndTricks`; update response type |
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
