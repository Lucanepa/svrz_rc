import { useEffect } from 'react';
import { setUiLang, type Lang } from './prefs';

/** Says which language this screen shows, for what speaks outside it — the
 *  API's answers (apiLang.ts) and the toast and confirm chrome. Leaving the
 *  screen hands back to the stored choice. */
export function useScreenLang(lang: Lang): void {
  useEffect(() => { setUiLang(lang); }, [lang]);
  useEffect(() => () => setUiLang(null), []);
}
