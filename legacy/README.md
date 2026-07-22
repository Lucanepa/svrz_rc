# Retired GitHub Pages deployment

This directory is **not** part of the app build. It is the entire contents of
<https://lucanepa.github.io/svrz_rc/> after the move to Cloudflare Pages, and it
exists for one reason: the old site was an installable PWA.

An installed PWA boots from its own precache. If we had simply stopped deploying
here, every phone with the old icon on its home screen would have kept opening
the retired build off disk — indefinitely, without ever asking whether the app
had moved. Coaches would have gone on filing feedback into a dead frontend.

So the old service-worker URL (`/svrz_rc/sw.js`) is still served, but the script
there now clears the caches, redirects any open window to the new domain, and
unregisters itself. `index.html` does the same for anyone arriving from a stale
bookmark or an old emailed link, preserving the `#hash` so survey and signature
tokens still resolve. `404.html` is a copy, so sub-paths behave the same.

Deployed by `.github/workflows/legacy-pages.yml`. Keep it up for at least one
full season — old PIN and survey mails are already in coaches' inboxes, and a
device that has not opened the app since the move has not yet run the kill
switch.
