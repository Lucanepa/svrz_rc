# RC app logo

The app icon: OpenVolley's ball (unchanged: one Swiss Volley red `#e2001a`
panel group, two stone-900 `#1c1917` groups) with a stone-900 referee whistle
in front of it, on white. The ball is cut away around the whistle by a gap as
wide as the ball's seams, and the whistle's sound opening is a hole. It is part
of the same family as OpenVolley (the ball on white), OpenBeach (the ball on
dune) and ReadVolley (the ball on a book).

It is only the app icon (launcher, browser tab, home screen, desktop). The app
headers and the PDF / PPTX reports keep the official Swiss Volley Region Zürich
logo (`src/assets/svrz-logo.png`, `src/SvrzLogo.tsx`).

The SVGs here are the source of every icon file. Change an SVG, then render
the rasters and commit them together:

```bash
python3 scripts/make-brand-assets.py
```

(resvg through the Tauri CLI in devDependencies, like OpenVolley's brand
script; Pillow.)

| File | What | Used for |
|---|---|---|
| `mark.svg` | Ball + whistle, 512 canvas, no background | apple-touch icon, maskable PWA icon, iOS icons, legacy Android launcher icons (square and round) |
| `icon-tile.svg` | White rounded tile with a stone-200 hairline, the mark inside | PWA `any` icons, desktop icons from 48 px (png, ico, icns, Windows tiles) |
| `icon-small.svg` | A fuller white tile, the mark 1.16× bigger | `public/favicon.png`, desktop icons below 48 px |
| `adaptive-foreground.svg` | The mark scaled 0.8, inside the adaptive icon's 66 dp safe circle | `mipmap-*/ic_launcher_foreground.png` (on the white `ic_launcher_background`) |

The gaps are masks, not white shapes: they show whatever is behind the logo.
Don't recolour the ball's panels, make more than one group red, or put the
mark on a dark background (the ink panels and whistle would vanish).
