# Email Feedback on Save — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When saving feedback, store the PDF in PocketBase, send an email with the PDF attached to the coachee (CC'd to RC + fixed address), and lock the game/role for further edits.

**Architecture:** Single enhanced endpoint (`POST /api/feedback/submit`) with 5 phases: validate → save + PDF upload → email (best-effort) → closure → response. Client generates PDF at `pixelRatio: 1.5`, sends as base64. Nodemailer + Migadu SMTP with custom From header.

**Tech Stack:** Nodemailer (SMTP), Express, PocketBase, html-to-image, jsPDF, React

**Spec:** `docs/superpowers/specs/2026-03-13-email-feedback-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `server/index.ts` | SMTP transport setup, enhanced `/api/feedback/submit` (validation, PDF upload, email, closure), `feedback_closed_roles` in eligible games, email HTML builder, HTML escape helper |
| `src/App.tsx` | Extract PDF generation helper, update `handleSaveFeedback` to generate PDF + send with request, `feedbackLocked` state + locked banner, update confirmation modal, closure status check |
| `src/lib/pocketbase.ts` | Update `saveFeedbackToPocketBase` params (add `pdfBase64`, `pdfFilename`, `tipsAndTricks`) and return type (`Promise<{id, emailSent, emailError?, emailWarning?}>`) |
| `src/types.ts` | Add `feedbackClosedRoles?: string[]` to `EligibleGame` |
| `.env.example` | Add SMTP + feedback email env vars |
| `package.json` | Add `nodemailer` + `@types/nodemailer` |

**Note:** Line numbers reference the codebase at plan creation time. As earlier tasks insert code, line numbers in later tasks will have shifted — use function/variable names as anchors rather than exact line numbers.

---

## Chunk 1: Dependencies, Config, and Types

### Task 1: Install nodemailer and add env vars

**Files:**
- Modify: `package.json`
- Modify: `.env.example`

- [ ] **Step 1: Install nodemailer**

```bash
cd /home/luca-canepa/Desktop/Github/svrz_rc
npm install nodemailer
npm install --save-dev @types/nodemailer
```

- [ ] **Step 2: Add SMTP and feedback env vars to `.env.example`**

Append after the VM sync section (after line 44):

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

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json .env.example
git commit -m "feat: add nodemailer dependency and SMTP env vars for email feedback"
```

---

### Task 2: Add `feedbackClosedRoles` to `EligibleGame` type

**Files:**
- Modify: `src/types.ts:41-52`

- [ ] **Step 1: Add `feedbackClosedRoles` field to `EligibleGame`**

In `src/types.ts`, add after `assignedRc?: string;` (line 51):

```ts
  feedbackClosedRoles?: string[];
```

- [ ] **Step 2: Commit**

```bash
git add src/types.ts
git commit -m "feat: add feedbackClosedRoles to EligibleGame type"
```

---

### Task 3: Update `saveFeedbackToPocketBase` signature and return type

**Files:**
- Modify: `src/lib/pocketbase.ts:85-103`

- [ ] **Step 1: Update params and return type**

Replace the current `saveFeedbackToPocketBase` function (lines 85-103) with:

```ts
export type FeedbackSubmitResponse = {
  id: string;
  emailSent: boolean;
  emailError?: string;
  emailWarning?: string;
};

export async function saveFeedbackToPocketBase(params: {
  gameId: string;
  role: FeedbackFormData['role'];
  formData: FeedbackFormData;
  pdfBase64: string;
  pdfFilename: string;
  tipsAndTricks: string;
}): Promise<FeedbackSubmitResponse> {
  const response = await fetch('/api/feedback/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      gameId: params.gameId,
      role: params.role,
      formData: params.formData,
      pdfBase64: params.pdfBase64,
      pdfFilename: params.pdfFilename,
      tipsAndTricks: params.tipsAndTricks,
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to save feedback: ${text}`);
  }
  return response.json() as Promise<FeedbackSubmitResponse>;
}
```

Note: This is a **breaking change** — the caller in `src/App.tsx` (`handleSaveFeedback`) will not compile until updated in Task 9. Do NOT commit this separately — it will be committed together with the App.tsx caller update in Task 9, Step 6.

- [ ] **Step 2: Verify the change is saved (no commit yet — waits for Task 9)**

---

## Chunk 2: Server — SMTP Setup, Email Builder, Body Limit

### Task 4: Add SMTP transport and increase body limit

**Files:**
- Modify: `server/index.ts:1-17` (imports and body limit)

- [ ] **Step 1: Add nodemailer import**

After the existing imports (line 5, after `import cron from 'node-cron';`), add:

```ts
import nodemailer from 'nodemailer';
```

- [ ] **Step 2: Add SMTP transport setup**

After line 9 (`dotenv.config();`), before `type AnyRecord`, add:

```ts
// SMTP transport for feedback emails
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

- [ ] **Step 3: Increase Express body limit**

Change line 17 from:

```ts
app.use(express.json({ limit: '2mb' }));
```

to:

```ts
app.use(express.json({ limit: '8mb' }));
```

- [ ] **Step 4: Commit**

```bash
git add server/index.ts
git commit -m "feat: add nodemailer SMTP transport and increase body limit to 8mb"
```

---

### Task 5: Add HTML escape helper and email builder function

**Files:**
- Modify: `server/index.ts` (add after the `snippetFromHtml` function, ~line 232)

- [ ] **Step 1: Add HTML escape helper**

After `snippetFromHtml` (around line 232), add:

```ts
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
```

- [ ] **Step 2: Add email builder function**

After the `escapeHtml` function, add:

```ts
function buildFeedbackEmailHtml(params: {
  matchNo: string;
  league: string;
  date: string;
  location: string;
  homeTeam: string;
  awayTeam: string;
  role: string;
  rcName: string;
  tipsAndTricks: string;
  surveyUrl: string;
}): string {
  const e = (s: string) => escapeHtml(s);
  const tipsSection = params.tipsAndTricks.trim()
    ? `
    <div style="margin: 24px 0; padding: 16px 20px; border-left: 4px solid #059669; background: #ecfdf5; border-radius: 0 8px 8px 0;">
      <h2 style="margin: 0 0 8px; font-size: 15px; font-weight: 600; color: #059669;">Tips &amp; Tricks</h2>
      <p style="margin: 0; font-size: 14px; color: #1e293b; white-space: pre-wrap; line-height: 1.6;">${e(params.tipsAndTricks)}</p>
    </div>`
    : '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin: 0; padding: 0; background-color: #f5f5f4; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <div style="max-width: 600px; margin: 0 auto; padding: 32px 16px;">
    <div style="background: #ffffff; border: 1px solid #e7e5e4; border-radius: 12px; padding: 32px; margin-bottom: 16px;">
      <h1 style="margin: 0 0 24px; font-size: 20px; font-weight: 700; color: #1c1917;">Referee Coaching Feedback</h1>
      <table style="width: 100%; border-collapse: collapse; font-size: 14px; color: #44403c;">
        <tr><td style="padding: 6px 12px 6px 0; font-weight: 600; white-space: nowrap; vertical-align: top;">Match No.</td><td style="padding: 6px 0;">${e(params.matchNo)}</td></tr>
        <tr><td style="padding: 6px 12px 6px 0; font-weight: 600; white-space: nowrap; vertical-align: top;">League</td><td style="padding: 6px 0;">${e(params.league)}</td></tr>
        <tr><td style="padding: 6px 12px 6px 0; font-weight: 600; white-space: nowrap; vertical-align: top;">Date</td><td style="padding: 6px 0;">${e(params.date)}</td></tr>
        <tr><td style="padding: 6px 12px 6px 0; font-weight: 600; white-space: nowrap; vertical-align: top;">Location</td><td style="padding: 6px 0;">${e(params.location)}</td></tr>
        <tr><td style="padding: 6px 12px 6px 0; font-weight: 600; white-space: nowrap; vertical-align: top;">Teams</td><td style="padding: 6px 0;">${e(params.homeTeam)} vs ${e(params.awayTeam)}</td></tr>
        <tr><td style="padding: 6px 12px 6px 0; font-weight: 600; white-space: nowrap; vertical-align: top;">Role Assessed</td><td style="padding: 6px 0;">${e(params.role)}</td></tr>
        <tr><td style="padding: 6px 12px 6px 0; font-weight: 600; white-space: nowrap; vertical-align: top;">Referee Coach</td><td style="padding: 6px 0;">${e(params.rcName)}</td></tr>
      </table>
      ${tipsSection}
      <div style="margin-top: 24px; padding-top: 20px; border-top: 1px solid #e7e5e4;">
        <p style="margin: 0 0 12px; font-size: 14px; color: #44403c;">We value your feedback on the coaching experience:</p>
        <a href="${e(params.surveyUrl)}" style="display: inline-block; padding: 10px 24px; background: #059669; color: #ffffff; text-decoration: none; border-radius: 8px; font-size: 14px; font-weight: 600;">Share Your Feedback</a>
      </div>
    </div>
    <div style="text-align: center; padding: 8px 0;">
      <p style="margin: 0 0 4px; font-size: 13px; color: #78716c;">The complete coaching feedback report is attached as a PDF.</p>
      <p style="margin: 0; font-size: 11px; color: #a8a29e;">This email was sent automatically by the SR-Coaching system.</p>
    </div>
  </div>
</body>
</html>`;
}

function buildFeedbackEmailText(params: {
  matchNo: string;
  league: string;
  date: string;
  location: string;
  homeTeam: string;
  awayTeam: string;
  role: string;
  rcName: string;
  tipsAndTricks: string;
  surveyUrl: string;
}): string {
  let text = `Referee Coaching Feedback\n\n`;
  text += `Match No.: ${params.matchNo}\n`;
  text += `League: ${params.league}\n`;
  text += `Date: ${params.date}\n`;
  text += `Location: ${params.location}\n`;
  text += `Teams: ${params.homeTeam} vs ${params.awayTeam}\n`;
  text += `Role Assessed: ${params.role}\n`;
  text += `Referee Coach: ${params.rcName}\n`;
  if (params.tipsAndTricks.trim()) {
    text += `\n--- Tips & Tricks ---\n${params.tipsAndTricks}\n`;
  }
  text += `\nWe value your feedback on the coaching experience:\n${params.surveyUrl}\n`;
  text += `\nThe complete coaching feedback report is attached as a PDF.\n`;
  text += `This email was sent automatically by the SR-Coaching system.\n`;
  return text;
}
```

- [ ] **Step 3: Commit**

```bash
git add server/index.ts
git commit -m "feat: add HTML escape helper and feedback email builder functions"
```

---

## Chunk 3: Server — Enhanced Endpoint (Validation + Save + Email + Closure)

### Task 6: Enhance `POST /api/feedback/submit` with all 5 phases

**Files:**
- Modify: `server/index.ts:1833-1940` (the existing endpoint handler)

- [ ] **Step 1: Replace the endpoint handler**

Replace the entire `app.post('/api/feedback/submit', ...)` handler (lines 1833-1940) with the enhanced version below. The existing save logic (feedback record, coachee update, observation) is preserved — the new code wraps it with validation before and email/closure after.

```ts
app.post('/api/feedback/submit', async (req: Request, res: ExpressResponse) => {
  const { gameId, role, formData, pdfBase64, pdfFilename, tipsAndTricks } = req.body ?? {};

  // Phase 1 — Validation
  if (!gameId || !role || !formData || !pdfBase64) {
    res.status(400).json({ error: 'gameId, role, formData and pdfBase64 are required.' });
    return;
  }

  // Validate PDF size (3MB decoded limit)
  const pdfBuffer = Buffer.from(String(pdfBase64), 'base64');
  if (pdfBuffer.length > 3 * 1024 * 1024) {
    res.status(400).json({ error: 'PDF exceeds 3MB size limit.' });
    return;
  }

  try {
    await ensureAdminAuth();

    // Fetch game and check closure
    const game = await withCollection(collectionCandidates.games, (collection) =>
      collection.getOne<AnyRecord>(String(gameId)),
    );

    const closedRoles: string[] = Array.isArray(game.feedback_closed_roles) ? game.feedback_closed_roles as string[] : [];
    if (closedRoles.includes(String(role))) {
      res.status(409).json({ error: `Feedback for role "${role}" has already been submitted for this game.` });
      return;
    }

    // Resolve coachee and validate email
    const refereeName = role === '1. SR' ? asText(game.first_referee) : asText(game.second_referee);
    if (!refereeName) {
      throw new Error(`No referee name found in game for role ${role}.`);
    }

    const escaped = escapeFilterValue(refereeName);
    const nameParts = refereeName.trim().split(/\s+/);
    const reversed = nameParts.length >= 2 ? nameParts.reverse().join(' ') : '';
    const escapedReversed = reversed ? escapeFilterValue(reversed) : '';
    const reverseClause = escapedReversed
      ? ` || full_name = "${escapedReversed}" || name = "${escapedReversed}" || coachee_name = "${escapedReversed}" || referee_name = "${escapedReversed}"`
      : '';
    const coacheeResult = await withCollection(collectionCandidates.coachees, async (collection) => ({
      collection,
      coachee: await collection.getFirstListItem<AnyRecord>(
        `full_name = "${escaped}" || name = "${escaped}" || coachee_name = "${escaped}" || referee_name = "${escaped}"${reverseClause}`,
      ),
    }));
    const coachee = coacheeResult.coachee;
    const coacheeCollection = coacheeResult.collection;

    const coacheeEmail = asText(coachee.email);
    if (!coacheeEmail) {
      res.status(400).json({ error: 'Coachee has no email address. Add an email in the admin panel before submitting feedback.' });
      return;
    }

    // Phase 2 — Save (existing logic)
    const submittedAt = new Date().toISOString();
    const refereeCoachPersonId = await resolveRefereeCoachPersonId(asText(formData.meta?.rc));

    const created = await withCollection<AnyRecord>(collectionCandidates.refereeCoaches, (collection) =>
      collection.create({
        game: game.id,
        coachee: coachee.id,
        rc_name: asText(formData.meta?.rc),
        role_assessed: String(role),
        feedback_json: formData,
        submitted_at: submittedAt,
      }),
    );

    const entries = Array.isArray(coachee.feedback_entries) ? coachee.feedback_entries : [];
    const nextEntries = [
      ...entries,
      {
        referee_coaches_id: created.id,
        game_id: game.id,
        submitted_at: submittedAt,
        role_assessed: role,
      },
    ];

    await coacheeCollection.update(coachee.id, {
      feedback_entries: nextEntries,
      last_feedback_at: submittedAt,
    });

    const grades = buildGradesPayload(formData);
    const observationPayload: Record<string, unknown> = {
      coachee: coachee.id,
      referee_coach: refereeCoachPersonId,
      game: game.id,
      coachee_function: mapCoacheeFunction(role),
      grades,
      remarks: asText(formData.results?.bemerkungen),
    };

    const gameLevel = mapGameLevel(formData.results?.spielniveau);
    if (gameLevel) observationPayload.game_level = gameLevel;
    const promotion = mapPromotion(formData.results?.einstufung);
    if (promotion) observationPayload.promotion = promotion;
    const motivation = mapMotivation(formData.results?.motivation);
    if (motivation) observationPayload.motivation = motivation;
    const srGoal = mapSrGoal(formData.results?.srZiel);
    if (srGoal) observationPayload.sr_goal = srGoal;
    const gameResult = asText(formData.results?.einstufung);
    if (gameResult) observationPayload.game_result = gameResult;
    observationPayload.second_observation = asBoolean(formData.results?.secondBesuch, false);

    await withCollection(collectionCandidates.observations, (collection) =>
      collection.create(observationPayload),
    );

    // Upload PDF to feedback record
    const pdfFormData = new FormData();
    pdfFormData.append('pdf_file', new Blob([pdfBuffer], { type: 'application/pdf' }), String(pdfFilename || 'feedback.pdf'));
    await withCollection(collectionCandidates.refereeCoaches, (collection) =>
      collection.update(created.id, pdfFormData),
    );

    // Phase 3 — Email (best-effort)
    let emailSent = false;
    let emailError: string | null = null;
    let emailWarning: string | null = null;

    try {
      // Resolve RC email
      let rcEmail = '';
      try {
        const rcPerson = await withCollection(collectionCandidates.refereeCoachPeople, (collection) =>
          collection.getOne<AnyRecord>(refereeCoachPersonId),
        );
        rcEmail = asText(rcPerson.email);
      } catch {
        // RC person fetch failed — continue without RC email
      }

      if (!rcEmail) {
        emailWarning = 'RC has no email, sent without RC in CC';
      }

      // Format date as dd.MM.yyyy
      const matchDate = asText(game.match_date);
      let formattedDate = matchDate;
      if (matchDate) {
        const d = new Date(matchDate);
        if (!isNaN(d.getTime())) {
          formattedDate = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
        }
      }

      const matchNo = asText(game.match_no);
      const lang = formData.lang === 'DE' ? 'DE' : 'EN';
      const subject = lang === 'DE'
        ? `SR-Coaching Feedback – Spiel ${matchNo} (${formattedDate})`
        : `Referee Coaching Feedback – Match ${matchNo} (${formattedDate})`;

      const surveyUrl = process.env.FEEDBACK_SURVEY_URL || '';
      const emailParams = {
        matchNo,
        league: asText(game.league),
        date: formattedDate,
        location: asText(game.location),
        homeTeam: asText(game.home_team),
        awayTeam: asText(game.away_team),
        role: String(role),
        rcName: asText(formData.meta?.rc),
        tipsAndTricks: String(tipsAndTricks || ''),
        surveyUrl,
      };

      const isTestMode = process.env.FEEDBACK_EMAIL_TEST === '1';
      const testRecipient = process.env.FEEDBACK_TEST_RECIPIENT || '';

      let mailTo: string;
      let mailCc: string[] | undefined;
      let mailSubject: string;

      if (isTestMode && testRecipient) {
        // Test mode: redirect all emails to test recipient, no CC
        mailTo = testRecipient;
        mailCc = undefined;
        mailSubject = `[TEST] ${subject}`;
        console.log(`[feedback-email] TEST MODE: redirecting email from ${coacheeEmail} to ${testRecipient}`);
      } else {
        mailTo = coacheeEmail;
        const ccList = [process.env.FEEDBACK_CC].filter(Boolean) as string[];
        if (rcEmail) ccList.unshift(rcEmail);
        mailCc = ccList.length > 0 ? ccList : undefined;
        mailSubject = subject;
      }

      await smtpTransport.sendMail({
        from: process.env.SMTP_FROM || 'coaching-feedback@svrz.ch',
        replyTo: rcEmail || undefined,
        to: mailTo,
        cc: mailCc,
        subject: mailSubject,
        html: buildFeedbackEmailHtml(emailParams),
        text: buildFeedbackEmailText(emailParams),
        attachments: [{
          filename: String(pdfFilename || 'feedback.pdf'),
          content: pdfBuffer,
          contentType: 'application/pdf',
        }],
      });

      emailSent = true;
    } catch (emailErr) {
      emailError = emailErr instanceof Error ? emailErr.message : String(emailErr);
      console.error('[feedback-email] Failed to send:', emailError);
    }

    // Phase 4 — Closure
    if (formData.results?.secondBesuch !== 'Y') {
      try {
        const updatedClosedRoles = [...closedRoles, String(role)];
        await withCollection(collectionCandidates.games, (collection) =>
          collection.update(game.id, { feedback_closed_roles: updatedClosedRoles }),
        );
      } catch (closeErr) {
        console.error('[feedback-closure] Failed to close game role:', closeErr);
      }
    }

    // Phase 5 — Response
    res.status(201).json({
      id: created.id,
      emailSent,
      emailError,
      emailWarning,
    });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});
```

- [ ] **Step 2: Verify the build compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add server/index.ts
git commit -m "feat: enhance feedback submit endpoint with PDF upload, email, and game closure"
```

---

### Task 7: Add `feedback_closed_roles` to eligible games response

**Files:**
- Modify: `server/index.ts:939-961` (the `getEligibleGames` function)

- [ ] **Step 1: Add `feedback_closed_roles` to the PocketBase `fields` query parameter**

In the `getEligibleGames` function, change the `fields` string (line 942) from:

```ts
      fields: 'id,match_no,league,match_date,location,home_team,away_team,first_referee,second_referee,assigned_rc',
```

to:

```ts
      fields: 'id,match_no,league,match_date,location,home_team,away_team,first_referee,second_referee,assigned_rc,feedback_closed_roles',
```

- [ ] **Step 2: Add `feedbackClosedRoles` to the response mapping**

In the `return games.map(...)` block (line 950-961), add after `assignedRc: asText(game.assigned_rc),`:

```ts
    feedbackClosedRoles: Array.isArray(game.feedback_closed_roles) ? game.feedback_closed_roles as string[] : [],
```

- [ ] **Step 3: Commit**

```bash
git add server/index.ts
git commit -m "feat: include feedbackClosedRoles in eligible games response"
```

---

## Chunk 4: Client — PDF Generation Helper, Save Flow, Form Locking

### Task 8: Extract PDF generation helper in App.tsx

**Files:**
- Modify: `src/App.tsx:241-245` (pdfFilename), `src/App.tsx:843-874` (handleDownloadPdf)

- [ ] **Step 1: Add a `generatePdfBase64` helper function**

After the existing `pdfFilename` function (line 245), add:

```ts
async function generatePdfBase64(element: HTMLElement, pixelRatio: number): Promise<string> {
  const imageData = await toPng(element, {
    pixelRatio,
    backgroundColor: '#ffffff',
  });

  const img = new Image();
  await new Promise<void>((resolve) => { img.onload = () => resolve(); img.src = imageData; });
  const pdfWidth = img.width * 0.75;
  const pdfHeight = img.height * 0.75;
  const pdf = new jsPDF({
    orientation: pdfWidth > pdfHeight ? 'l' : 'p',
    unit: 'pt',
    format: [pdfWidth, pdfHeight],
  });
  pdf.addImage(imageData, 'PNG', 0, 0, pdfWidth, pdfHeight);

  const arrayBuffer = pdf.output('arraybuffer');
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
```

- [ ] **Step 2: Verify `handleDownloadPdf` remains unchanged**

`handleDownloadPdf` (lines 843-874) stays as-is — it uses `pixelRatio: 2` for high-quality downloads and has the Web Share API fallback. The new `generatePdfBase64` helper is only used by `handleSaveFeedback` (Task 9) with `pixelRatio: 1.5` for email-sized PDFs.

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "feat: add generatePdfBase64 helper for email PDF generation"
```

---

### Task 9: Update `handleSaveFeedback` to generate PDF and handle response

**Files:**
- Modify: `src/App.tsx:876-896` (handleSaveFeedback)

- [ ] **Step 1: Add new UI strings for email feedback**

In `UI_STRINGS.DE` (after `saveOk` on line 102), add:

```ts
    saveOkEmail: "Feedback gespeichert und E-Mail gesendet.",
    saveOkNoEmail: "Feedback gespeichert, aber E-Mail fehlgeschlagen:",
    feedbackLocked: "Feedback eingereicht",
    gameClosed: "Dieses Spiel wurde für diese Rolle bereits beobachtet",
```

In `UI_STRINGS.EN` (after `saveOk` on line 192), add:

```ts
    saveOkEmail: "Feedback saved and email sent.",
    saveOkNoEmail: "Feedback saved, but email failed:",
    feedbackLocked: "Feedback submitted",
    gameClosed: "This game has already been observed for this role",
```

- [ ] **Step 2: Add `feedbackLocked` state**

After the `tipsAndTricks` state (line 935), add:

```ts
  const [feedbackLocked, setFeedbackLocked] = useState(false);
```

- [ ] **Step 3: Update `handleSaveFeedback`**

Replace the `handleSaveFeedback` function (lines 876-896) with:

```ts
  const handleSaveFeedback = async () => {
    if (!selectedGame || !printableRef.current) {
      setBackendNotice(t.noGames);
      return;
    }
    setSavingFeedback(true);
    setBackendNotice('');
    try {
      const base64 = await generatePdfBase64(printableRef.current, 1.5);
      const result = await saveFeedbackToPocketBase({
        gameId: selectedGame.id,
        role: formData.role,
        formData,
        pdfBase64: base64,
        pdfFilename: pdfFilename(formData),
        tipsAndTricks,
      });

      if (result.emailSent) {
        setBackendNotice(result.emailWarning
          ? `${t.saveOkEmail} (${result.emailWarning})`
          : t.saveOkEmail);
      } else {
        setBackendNotice(`${t.saveOkNoEmail} ${result.emailError || 'Unknown error'}`);
      }

      // Lock form if not second observation
      if (formData.results.secondBesuch !== 'Y') {
        setFeedbackLocked(true);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setBackendNotice(`${t.saveError} ${localizeRuntimeError(reason, formData.lang)}`);
    } finally {
      setSavingFeedback(false);
    }
  };
```

- [ ] **Step 4: Reset `feedbackLocked` and `tipsAndTricks` in `doResetForm`**

In the `doResetForm` function (around line 940-949), add before `setShowConfirmModal(null);`:

```ts
    setFeedbackLocked(false);
    setTipsAndTricks('');
```

- [ ] **Step 5: Reset `feedbackLocked` when selecting a new game/coachee**

Add `setFeedbackLocked(false);` alongside existing `setSelectedGameId(...)` calls at these exact locations:
- Line 605: after `setSelectedGameId(games[0].id);`
- Line 665: after `setSelectedGameId(game.id);`
- Line 749: after `setSelectedGameId(mappedGame.id);`

Also reset when changing coachee — add `setFeedbackLocked(false);` alongside `setSelectedCoacheeId(...)` calls.

- [ ] **Step 6: Commit**

This commit includes both `src/lib/pocketbase.ts` (from Task 3) and `src/App.tsx` changes:

```bash
git add src/App.tsx src/lib/pocketbase.ts
git commit -m "feat: update handleSaveFeedback with PDF generation, email handling, and form locking"
```

---

### Task 10: Add locked UI banner and closure status check

**Files:**
- Modify: `src/App.tsx` (save button area, ~line 1966-1976)

- [ ] **Step 1: Check closure status from eligible game data**

Derive a `isGameRoleClosed` computed value. Add near the other derived values:

```ts
  const isGameRoleClosed = selectedGame?.feedbackClosedRoles?.includes(formData.role) ?? false;
```

- [ ] **Step 2: Add locked/closed banner above the save button**

Before the save button `<div>` (line 1966), add:

```tsx
      {(feedbackLocked || isGameRoleClosed) && (
        <div className="max-w-4xl mx-auto mt-4 no-print">
          <div className="bg-stone-100 border border-stone-300 rounded-lg px-4 py-3 text-sm text-stone-600 font-medium">
            {isGameRoleClosed ? t.gameClosed : t.feedbackLocked}
          </div>
        </div>
      )}
```

- [ ] **Step 3: Hide save button when locked or closed**

Wrap the save button `<div>` in a conditional so it is hidden (not just disabled) when locked or closed:

```tsx
      {!feedbackLocked && !isGameRoleClosed && (
        <div className="max-w-4xl mx-auto mt-4 flex justify-end no-print">
          <button
            onClick={() => setShowConfirmModal('save')}
            disabled={savingFeedback || !selectedGame}
            className="flex items-center gap-2 bg-emerald-600 text-white px-6 py-3 rounded-lg shadow-sm hover:bg-emerald-700 transition-colors disabled:opacity-50 font-medium"
          >
            <Database size={18} />
            <span>{savingFeedback ? t.loading : t.saveBackend}</span>
          </button>
        </div>
      )}
```

- [ ] **Step 4: Disable all form inputs when locked**

Pass `feedbackLocked || isGameRoleClosed` as a `disabled` condition to all form sections. The simplest approach: add a `const formDisabled = feedbackLocked || isGameRoleClosed;` derived value, then add `pointer-events-none opacity-60` to the form container when `formDisabled` is true. Wrap the main form area (assessment sections, results, tips & tricks) in:

```tsx
<div className={cn(formDisabled && 'pointer-events-none opacity-60')}>
  {/* existing form content */}
</div>
```

This visually and functionally disables all inputs without modifying each individual input element.

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx
git commit -m "feat: add feedback locked banner, form disabling, and game closure check in UI"
```

---

### Task 11: Update confirmation modal to show recipient email

**Files:**
- Modify: `src/App.tsx:1984-2027` (confirmation modal)

- [ ] **Step 1: Derive the coachee email for display**

The codebase tracks `selectedCoacheeId` (line 471) and `coachees` array (line 474). Look up the email from the coachees list. Add near the other derived values (after `selectedGame` at line 496):

```ts
  const selectedCoacheeEmail = useMemo(() => {
    const c = coachees.find(c => c.id === selectedCoacheeId);
    return c?.email || '';
  }, [coachees, selectedCoacheeId]);
```

- [ ] **Step 2: Update the modal text for save confirmation**

In the confirmation modal, update the save description paragraph (line 1993-1995). Change from:

```tsx
                ? (formData.lang === 'DE' ? 'Das Feedback wird in der Datenbank gespeichert.' : 'The feedback will be saved to the database.')
```

to:

```tsx
                ? (formData.lang === 'DE'
                  ? `Das Feedback wird gespeichert und eine E-Mail mit dem PDF wird an ${selectedCoacheeEmail || '(keine E-Mail)'} gesendet.`
                  : `The feedback will be saved and an email with the PDF will be sent to ${selectedCoacheeEmail || '(no email)'}.`)
```

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "feat: show recipient email in save confirmation modal"
```

---

## Chunk 5: Final Verification

### Task 12: Build verification and manual testing checklist

- [ ] **Step 1: Run TypeScript check**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 2: Run Vite build**

```bash
npm run build
```

Expected: Build succeeds.

- [ ] **Step 3: Manual testing checklist (PocketBase schema must be configured first)**

Before testing, apply PocketBase schema changes manually in the PB admin UI:
1. `games` collection: Add `feedback_closed_roles` (JSON, default `[]`)
2. `referee_coach_feedbacks` collection: Add `pdf_file` (File, single, max 5MB)
3. `referee_coaches` people collection: Verify/add `email` (Text, optional)
4. `coachees` collection: Verify `email` field exists

Then test:
- [ ] Select a coachee with an email, fill out feedback, click Save → confirm email shown in modal → save succeeds → email sent
- [ ] After save (non-second-visit): form is locked, save button disabled, banner shown
- [ ] Reset form: lock clears
- [ ] Select same game+role again: closure banner shown, save disabled
- [ ] Coachee without email: save rejected with 400 error
- [ ] Tips & Tricks: included in email body, not stored in PB

- [ ] **Step 4: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: address issues found during build verification"
```
