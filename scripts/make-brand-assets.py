"""Every app-icon raster of the RC app, rendered from the SVGs in brand/.

    python3 scripts/make-brand-assets.py

Rerun after changing a file in brand/ (see brand/README.md), check the
renders, commit them with the SVG. It writes:

- public/: favicon.png, apple-touch-icon.png, pwa-192x192.png,
  pwa-512x512.png, pwa-maskable-512x512.png (PWA manifest)
- src-tauri/icons: desktop icons (png, ico, icns, Windows Square*Logo /
  StoreLogo), ios/ (opaque squares: iOS draws the rounded corners), and
  android/ (the copy that `tauri icon` would overwrite)
- src-tauri/gen/android/app/src/main/res/mipmap-*: the Android launcher
  icons (square, round, adaptive foreground) for every density

The official Swiss Volley Region Zürich logo (src/assets/svrz-logo.png, in the
app headers and the PDF / PPTX reports) is not touched.

The SVGs are rasterised by resvg through the Tauri CLI (`tauri icon --png`,
a devDependency, works offline); Pillow composes and writes .ico / .icns.
Needs: npm install, Pillow.
"""
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
BRAND = ROOT / 'brand'
PUBLIC = ROOT / 'public'
ICONS = ROOT / 'src-tauri/icons'
RES = ROOT / 'src-tauri/gen/android/app/src/main/res'
TAURI = os.environ.get('TAURI_CLI') or str(ROOT / 'node_modules/.bin/tauri')
WHITE = (255, 255, 255, 255)
CLEAR = (0, 0, 0, 0)

_tmp = Path(tempfile.mkdtemp(prefix='rc-brand-'))
_cache = {}


def render(name, size):
    """brand/<name> rasterised to size x size px, RGBA."""
    key = (name, size)
    if key not in _cache:
        n = len(_cache)
        src = _tmp / f'{n}.svg'
        shutil.copyfile(BRAND / name, src)
        subprocess.run([TAURI, 'icon', str(src), '--png', str(size), '-o', str(_tmp / str(n))],
                       check=True, capture_output=True, cwd=_tmp)
        _cache[key] = Image.open(_tmp / str(n) / f'{size}x{size}.png').convert('RGBA')
    return _cache[key].copy()


def on_canvas(size, name, fraction, background=WHITE):
    """brand/<name> (a 512 canvas) at `fraction` of a size x size square."""
    canvas = Image.new('RGBA', (size, size), background)
    art = render(name, round(size * fraction))
    canvas.alpha_composite(art, ((size - art.width) // 2, (size - art.height) // 2))
    return canvas


def masked(img, shape, radius_fraction=0.0):
    ss = 4
    m = Image.new('L', (img.width * ss, img.height * ss), 0)
    box = (0, 0, m.width - 1, m.height - 1)
    if shape == 'circle':
        ImageDraw.Draw(m).ellipse(box, fill=255)
    else:
        ImageDraw.Draw(m).rounded_rectangle(box, radius=int(m.width * radius_fraction), fill=255)
    out = Image.new('RGBA', img.size, CLEAR)
    out.paste(img, (0, 0), m.resize(img.size, Image.LANCZOS))
    return out


def save_png(im, path, rgb=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    (im.convert('RGB') if rgb else im).save(path, optimize=True)
    print('wrote', path.relative_to(ROOT))


def tile(size):
    """The icon at size px: the fuller small cut below 48 px, the tile above."""
    return render('icon-small.svg' if size < 48 else 'icon-tile.svg', size)


# ---- web ---------------------------------------------------------------
save_png(render('icon-small.svg', 64), PUBLIC / 'favicon.png')
# iOS rounds the corners itself: an opaque white square
save_png(on_canvas(180, 'mark.svg', 0.86), PUBLIC / 'apple-touch-icon.png', rgb=True)
for s in (192, 512):
    save_png(render('icon-tile.svg', s), PUBLIC / f'pwa-{s}x{s}.png')
save_png(on_canvas(512, 'mark.svg', 0.9), PUBLIC / 'pwa-maskable-512x512.png', rgb=True)

# ---- desktop (Tauri) -------------------------------------------------------
for name, size in (('32x32', 32), ('64x64', 64), ('128x128', 128), ('128x128@2x', 256), ('icon', 512)):
    save_png(tile(size), ICONS / f'{name}.png')
for path in sorted(ICONS.glob('Square*Logo.png')) + [ICONS / 'StoreLogo.png']:
    save_png(tile(Image.open(path).width), path)
ico = [tile(s) for s in (16, 24, 32, 48, 64, 256)]
ico[-1].save(ICONS / 'icon.ico', format='ICO', sizes=[im.size for im in ico], append_images=ico[:-1])
print('wrote', (ICONS / 'icon.ico').relative_to(ROOT))
icns = [tile(s) for s in (16, 32, 64, 128, 256, 512, 1024)]
icns[-1].save(ICONS / 'icon.icns', format='ICNS', append_images=icns[:-1])
print('wrote', (ICONS / 'icon.icns').relative_to(ROOT))

# iOS: opaque squares, each at its own pixel size (AppIcon-20x20@2x.png = 40 px)
for path in sorted((ICONS / 'ios').glob('AppIcon-*.png')):
    m = re.match(r'AppIcon-([\d.]+)(?:x[\d.]+)?@(\d)x', path.name)
    size = round(float(m.group(1)) * int(m.group(2)))
    save_png(on_canvas(size, 'mark.svg', 0.86), path, rgb=True)

# ---- Android ---------------------------------------------------------------
for folder, d in (('mdpi', 1), ('hdpi', 1.5), ('xhdpi', 2), ('xxhdpi', 3), ('xxxhdpi', 4)):
    launcher = round(48 * d)   # legacy icons (API < 26): a white rounded tile, a white disc
    fg = round(108 * d)        # adaptive layers: 108 dp canvas, 66 dp safe circle
    images = {
        'ic_launcher.png': masked(on_canvas(launcher, 'mark.svg', 0.9), 'rounded', 0.18),
        'ic_launcher_round.png': masked(on_canvas(launcher, 'mark.svg', 0.86), 'circle'),
        'ic_launcher_foreground.png': render('adaptive-foreground.svg', fg),
    }
    for base in (RES, ICONS / 'android'):
        for name, im in images.items():
            save_png(im, base / f'mipmap-{folder}' / name)

shutil.rmtree(_tmp, ignore_errors=True)
