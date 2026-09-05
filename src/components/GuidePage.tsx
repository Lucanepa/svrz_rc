import { useEffect, useState } from 'react';
import { Video, ExternalLink, Subtitles, Check } from 'lucide-react';
import SvrzLogo from '../SvrzLogo';
import { getStoredLang, type Lang } from '../lib/prefs';

/**
 * The narrated guide, on its own page.
 *
 * Public and unauthenticated, like the signature and survey pages: this URL is
 * what gets pasted into the coaches' WhatsApp group, and asking someone to sign
 * in before they can watch an explainer about signing in is a circle. Nothing
 * here reads or writes any data — the videos are filmed against demo data and
 * served from the media bucket.
 *
 * A page rather than a dialog inside the app so the link is the thing people
 * keep. A modal cannot be sent to anybody.
 */

// Same bucket the app's own links use. Re-recording overwrites the key, so this
// URL keeps working and there is no version to bump anywhere.
const MEDIA = 'https://svrz-rc-media.openvolley.app';

const STR = {
  DE: {
    kicker: 'Referee Coaching',
    title: 'Video-Anleitung',
    lead: 'Wie du als Referee Coach eine Beobachtung erfasst, unterschreiben lässt und absendest — vom Öffnen des Spiels bis zur E-Mail an den Schiedsrichter.',
    compareTitle: 'Was sich ändert',
    beforeLabel: 'Bisher',
    beforeSub: 'von Hand, in vier Werkzeugen',
    nowLabel: 'Jetzt',
    nowSub: 'einmal ausfüllen, fertig',
    beforeSteps: [
      'Spiele im VolleyManager zusammensuchen',
      'Beobachtung während des Spiels auf Papier notieren',
      'Zu Hause alles nochmals ins Google-Formular tippen',
      'Die Excel-Tabelle von Hand nachführen',
      'Die E-Mail an den Schiedsrichter selber schreiben',
    ],
    nowSteps: [
      'Spiel antippen — deine Spiele stehen schon in der App',
      'Formular ausfüllen; Liga, Halle, Teams und Resultat sind bereits drin',
      'Der Schiedsrichter unterschreibt in der Halle auf deinem Handy',
      'Senden — E-Mail mit PDF, Kopie ans RC Präsidium, Statistik nachgeführt',
    ],
    compareFoot: 'Nichts wird zweimal erfasst: was du in der Halle einträgst, ist genau das, was der Schiedsrichter bekommt.',
    chapters: 'Inhalt',
    subtitles: 'Untertitel lassen sich im ⚙-Menü des Players ein- und ausschalten.',
    openDirect: 'Video direkt öffnen',
    other: 'English version',
    noPlay: 'Dein Browser kann dieses Video nicht abspielen.',
    app: 'Zur App',
    chapterList: [
      'Anmelden und Startseite',
      'Coachees und Spiele',
      'Das Formular ausfüllen',
      'Unterschreiben und senden',
      'Auf dem Handy, auch offline',
      'Entwürfe: nichts geht verloren',
    ],
  },
  EN: {
    kicker: 'Referee Coaching',
    title: 'Video guide',
    lead: 'How you record an observation as a referee coach, get it signed and send it — from opening the game to the email the referee receives.',
    compareTitle: 'What changes',
    beforeLabel: 'Until now',
    beforeSub: 'by hand, across four tools',
    nowLabel: 'From now on',
    nowSub: 'fill it in once, done',
    beforeSteps: [
      'Hunt for the games in VolleyManager',
      'Write the observation on paper during the match',
      'Type it all again into the Google Form at home',
      'Keep the Excel sheet up to date by hand',
      'Write the email to the referee yourself',
    ],
    nowSteps: [
      'Tap the game — your games are already in the app',
      'Fill in the form; league, venue, teams and result are already there',
      'The referee signs on your phone, in the gym',
      'Send — email with the PDF, copy to the RC Präsidium, statistics updated',
    ],
    compareFoot: 'Nothing is recorded twice: what you enter in the gym is exactly what the referee receives.',
    chapters: 'Contents',
    subtitles: 'Subtitles can be switched on and off in the player’s ⚙ menu.',
    openDirect: 'Open the video directly',
    other: 'Deutsche Version',
    noPlay: 'Your browser cannot play this video.',
    app: 'Go to the app',
    chapterList: [
      'Signing in and the home screen',
      'Coachees and games',
      'Filling in the form',
      'Signing and sending',
      'On your phone, offline too',
      'Drafts: nothing gets lost',
    ],
  },
} satisfies Record<Lang, Record<string, unknown>>;

/** `#/guide/en` pins a language; a bare `#/guide` follows the device. */
function langFromHash(): Lang | null {
  const m = window.location.hash.match(/#\/guide\/(de|en)\b/i);
  return m ? (m[1].toLowerCase() === 'en' ? 'EN' : 'DE') : null;
}

export default function GuidePage() {
  const [lang, setLang] = useState<Lang>(() =>
    langFromHash()
    ?? getStoredLang()
    ?? (navigator.language?.toLowerCase().startsWith('en') ? 'EN' : 'DE'));
  const t = STR[lang];
  const code = lang === 'DE' ? 'de' : 'en';

  useEffect(() => {
    document.documentElement.lang = code;
    document.title = lang === 'DE' ? 'Video-Anleitung — SR-Coaching' : 'Video guide — Referee Coaching';
  }, [lang, code]);

  const choose = (next: Lang) => {
    setLang(next);
    // Deliberately NOT setStoredLang: this page is public and its URL gets
    // pasted into a group chat. Writing the shared preference would mean a
    // colleague opening someone's `#/guide/en` link found their whole app in
    // English afterwards — a setting they never touched, changed by reading a
    // message. The stored language is read as a DEFAULT above and left alone.
    //
    // Safe to write the hash: main.tsx only reloads when the route KIND
    // changes, and de -> en is the same kind. The link a coach copies out of
    // the address bar then carries the language they actually watched.
    window.location.hash = `#/guide/${next === 'DE' ? 'de' : 'en'}`;
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-stone-50 to-stone-100">
      <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:py-12">
        <header className="flex items-start justify-between gap-4 mb-8">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-400">{t.kicker}</p>
            <h1 className="mt-1 text-2xl sm:text-3xl font-bold tracking-tight text-stone-900">{t.title}</h1>
          </div>
          <SvrzLogo className="h-9 sm:h-11 w-auto shrink-0" />
        </header>

        <p className="text-sm sm:text-base leading-relaxed text-stone-600 mb-6">{t.lead}</p>

        {/* Before / after, above the video and not below it.
            The people this page has to convince are the ones who will not press
            play: the pitch is not "watch six minutes", it is "you already do
            five things, now you do four, and none of them twice". Reading it
            takes fifteen seconds and it is the whole argument.
            Both columns are the REAL processes — the left one is what the
            coaches did through 2025/26 (VolleyManager, paper, the Google form,
            the Excel sheet, the mail), not a strawman. Anyone who did it will
            recognise their own season there, which is the only reason the right
            column is believed. */}
        <section className="mb-8 rounded-2xl bg-white shadow-card border border-stone-200/70 overflow-hidden">
          <h2 className="px-5 pt-4 pb-3 text-sm font-semibold text-stone-800">{t.compareTitle}</h2>
          <div className="grid sm:grid-cols-2 border-t border-stone-200/70 divide-y sm:divide-y-0 sm:divide-x divide-stone-200/70">
            <div className="p-5 bg-stone-50/70">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-400">{t.beforeLabel}</p>
              <p className="mt-1 text-xs text-stone-400">{t.beforeSub}</p>
              <ol className="mt-3 space-y-2">
                {t.beforeSteps.map((s, i) => (
                  <li key={s} className="flex gap-2.5 text-sm leading-snug text-stone-500">
                    <span className="w-4 shrink-0 tabular-nums text-xs pt-0.5 text-stone-400">{i + 1}.</span>
                    <span>{s}</span>
                  </li>
                ))}
              </ol>
            </div>
            <div className="p-5">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-red-700">{t.nowLabel}</p>
              <p className="mt-1 text-xs text-stone-500">{t.nowSub}</p>
              <ol className="mt-3 space-y-2">
                {t.nowSteps.map((s) => (
                  <li key={s} className="flex gap-2.5 text-sm leading-snug text-stone-700">
                    <Check size={14} className="shrink-0 mt-0.5 text-red-700" />
                    <span>{s}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
          <p className="px-5 py-3 border-t border-stone-200/70 bg-stone-50/70 text-xs leading-relaxed text-stone-500">{t.compareFoot}</p>
        </section>

        {/* `key` on the language: changing the src of a live <video> keeps the
            old buffer and the old text track, so the previous language's picture
            would run under the new subtitles. Re-mounting is the honest way.
            `crossOrigin` is REQUIRED — the media is on another host, and a
            cross-origin <track> is dropped in silence without it: the video
            plays and the captions simply never appear.
            The poster is LOCAL for that same reason turned around: crossOrigin
            puts the poster into CORS mode too, and a cross-origin image the
            edge has cached without an Access-Control header fails with nothing
            to show for it. Twenty kilobytes shipped with the app removes the
            question entirely, and the frame is the title card, which does not
            change between recordings. */}
        <div className="rounded-2xl overflow-hidden shadow-card border border-stone-200/70 bg-black">
          <video
            key={code}
            controls
            playsInline
            preload="metadata"
            crossOrigin="anonymous"
            poster={`${import.meta.env.BASE_URL}img/guide-poster-${code}.jpg`}
            className="w-full aspect-[16/10] bg-black"
          >
            <source src={`${MEDIA}/guide-${code}.mp4`} type="video/mp4" />
            <track
              default
              kind="subtitles"
              srcLang={code}
              label={lang === 'DE' ? 'Deutsch' : 'English'}
              src={`${MEDIA}/guide-${code}.vtt`}
            />
            {t.noPlay}
          </video>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-stone-500">
          <span className="inline-flex items-center gap-1.5"><Subtitles size={13} /> {t.subtitles}</span>
          {/* The way out when an in-page player will not play — an old WebView,
              a browser with media restrictions — and the file a coach forwards. */}
          <a
            href={`${MEDIA}/guide-${code}.mp4`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 font-medium text-red-700 hover:underline"
          >
            <ExternalLink size={13} /> {t.openDirect}
          </a>
        </div>

        <section className="mt-8 rounded-2xl bg-white shadow-card border border-stone-200/70 p-5">
          <h2 className="text-sm font-semibold text-stone-800 mb-3 flex items-center gap-2">
            <Video size={15} className="text-stone-400" /> {t.chapters}
          </h2>
          <ol className="space-y-1.5 text-sm text-stone-600">
            {t.chapterList.map((c, i) => (
              <li key={c} className="flex gap-3">
                <span className="w-5 shrink-0 tabular-nums text-stone-400">{i + 1}.</span>
                <span>{c}</span>
              </li>
            ))}
          </ol>
        </section>

        <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
          <button
            onClick={() => choose(lang === 'DE' ? 'EN' : 'DE')}
            className="h-9 inline-flex items-center gap-1.5 px-3 rounded-lg border border-stone-200 text-xs font-medium bg-white text-stone-600 hover:bg-stone-50 transition-colors"
          >
            {t.other}
          </button>
          <a
            href={`${import.meta.env.BASE_URL}`}
            className="h-9 inline-flex items-center gap-1.5 px-3 rounded-lg bg-stone-900 text-white text-xs font-semibold hover:bg-stone-800 transition-colors"
          >
            {t.app}
          </a>
        </div>

        <p className="mt-8 text-center text-[11px] text-stone-400">
          SVRZ | SR-Wesen | Referee Coaching | schiricoaching@svrz.ch
        </p>
      </div>
    </div>
  );
}
