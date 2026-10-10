#!/usr/bin/env python3
"""
fetch-sample-images.py — download a handful of public test images so you can
verify Recall end-to-end without hunting through your own screenshot folder.

Uses public placeholder APIs rather than scraping arbitrary sites: they're
documented, they permit it, and they won't break when a page's HTML changes.

    python3 scripts/fetch-sample-images.py --count 5
    python3 scripts/fetch-sample-images.py --count 20 --source wikimedia
    python3 scripts/fetch-sample-images.py --out ~/pics --count 50

Sources
  picsum     Real photographs from Lorem Picsum. Fast, no text in them.
  wikimedia  Wikimedia Commons. Slower, but many images contain real text
             (book pages, diagrams, signage) — the better OCR test.

No dependencies: standard library only, so it runs on a fresh machine with
nothing installed. Images land flat in --out, ready for:
    npm run index -- --folder <that dir>
"""

import argparse
import json
import os
import random
import sys
import urllib.error
import urllib.parse
import urllib.request

# Wikimedia asks for a descriptive User-Agent. Be a good citizen.
USER_AGENT = "RecallSampleFetcher/1.0 (local testing; contact: recall@example.invalid)"
TIMEOUT = 20

PICSUM_URL = "https://picsum.photos/seed/{seed}/{w}/{h}"
WIKIMEDIA_API = "https://commons.wikimedia.org/w/api.php"

# Categories with lots of text-bearing images, which is what OCR needs to chew on.
WIKIMEDIA_CATEGORIES = [
    "Category:Scanned documents",
    "Category:Diagrams",
    "Category:Whiteboards",
    "Category:Manuscripts",
    "Category:Technical drawings",
]


def log(msg):
    print(msg, flush=True)


def fetch_bytes(url, accept="image/*"):
    """GET a URL and return the body, or None on any failure."""
    req = urllib.request.Request(
        url,
        headers={"User-Agent": USER_AGENT, "Accept": accept},
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            return resp.read()
    except urllib.error.HTTPError as e:
        log(f"    HTTP {e.code}")
    except urllib.error.URLError as e:
        log(f"    network error: {e.reason}")
    except Exception as e:  # noqa: BLE001 - a bad image must not kill the run
        log(f"    failed: {e}")
    return None


def save(data, path):
    """Write bytes, skipping anything that is implausibly small to be an image."""
    if not data or len(data) < 1024:
        return False
    try:
        with open(path, "wb") as fh:
            fh.write(data)
    except OSError as e:
        log(f"    could not write {path}: {e}")
        return False
    return True


def ext_from(data):
    """Sniff the container from magic bytes; PNG is enough for our purposes."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if data.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if data.startswith(b"GIF8"):
        return ".gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    return ".png"


def fetch_picsum(count, out_dir, rng, width, height):
    """Download count random photos from Lorem Picsum."""
    log(f"\nFetching {count} image(s) from picsum.photos ...")
    got = 0
    for i in range(count):
        seed = rng.randint(1, 1_000_000)
        url = PICSUM_URL.format(seed=seed, w=width, h=height)
        name = f"picsum-{i:03d}-{seed}.png"
        dest = os.path.join(out_dir, name)

        if os.path.exists(dest):
            log(f"  [{i + 1}/{count}] have {name}")
            got += 1
            continue

        log(f"  [{i + 1}/{count}] {name}")
        data = fetch_bytes(url)
        if data and save(data, dest + ".tmp"):
            os.replace(dest + ".tmp", dest)
            got += 1
        else:
            log("    skipped")
    return got


def wikimedia_candidates(count, rng):
    """Ask the Commons API for thumbnail URLs of text-bearing images."""
    params = {
        "action": "query",
        "format": "json",
        "generator": "categorymembers",
        "gcmtitle": rng.choice(WIKIMEDIA_CATEGORIES),
        "gcmtype": "file",
        "gcmlimit": str(max(count * 3, 20)),
        "prop": "imageinfo",
        "iiprop": "url|mime",
        "iiurlwidth": "1280",
    }
    url = WIKIMEDIA_API + "?" + urllib.parse.urlencode(params)
    raw = fetch_bytes(url, accept="application/json")
    if not raw:
        return []

    try:
        data = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as e:
        log(f"  could not parse API response: {e}")
        return []

    pages = (data.get("query") or {}).get("pages") or {}
    out = []
    for page in pages.values():
        info = (page.get("imageinfo") or [{}])[0]
        thumb = info.get("thumburl")
        mime = info.get("mime", "")
        if thumb and mime.startswith("image/") and "svg" not in mime:
            out.append(thumb)
    return out


def fetch_wikimedia(count, out_dir, rng):
    """Download count images that tend to contain real text."""
    log(f"\nFetching {count} image(s) from Wikimedia Commons ...")
    candidates = wikimedia_candidates(count, rng)
    if not candidates:
        log("  no candidates returned; try --source picsum")
        return 0

    rng.shuffle(candidates)
    got = 0
    for i, url in enumerate(candidates[:count]):
        name = f"wikimedia-{i:03d}{ext_from_url(url)}"
        dest = os.path.join(out_dir, name)

        if os.path.exists(dest):
            log(f"  [{i + 1}/{count}] have {name}")
            got += 1
            continue

        log(f"  [{i + 1}/{count}] {name}")
        data = fetch_bytes(url)
        if data and save(data, dest + ".tmp"):
            os.replace(dest + ".tmp", dest)
            got += 1
    return got


def ext_from_url(url):
    """Pull a sensible extension off a Commons thumbnail URL."""
    path = urllib.parse.urlparse(url).path
    for ext in (".png", ".jpg", ".jpeg", ".gif", ".webp"):
        if path.lower().endswith(ext):
            return ".jpg" if ext == ".jpeg" else ext
    return ".png"


def main():
    ap = argparse.ArgumentParser(
        description="Download public sample images for testing Recall.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--count", type=int, default=20, help="how many images (default 20)")
    ap.add_argument(
        "--out",
        default="sample-images",
        help="output directory (default: ./sample-images)",
    )
    ap.add_argument(
        "--source",
        choices=("picsum", "wikimedia"),
        default="picsum",
        help="picsum = photos, wikimedia = images with more text (default picsum)",
    )
    ap.add_argument("--seed", type=int, default=None, help="seed for reproducible picks")
    ap.add_argument("--width", type=int, default=1280, help="image width (default 1280)")
    ap.add_argument("--height", type=int, default=720, help="image height (default 720)")
    args = ap.parse_args()

    if args.count < 1:
        log("error: --count must be at least 1")
        return 2
    if args.count > 200:
        log("error: --count above 200 is not a quick test; fetch fewer")
        return 2

    out_dir = os.path.abspath(os.path.expanduser(args.out))
    try:
        os.makedirs(out_dir, exist_ok=True)
    except OSError as e:
        log(f"error: cannot create {out_dir}: {e}")
        return 1

    rng = random.Random(args.seed)

    log(f"Output: {out_dir}")
    log(f"Source: {args.source}   Count: {args.count}")

    if args.source == "wikimedia":
        got = fetch_wikimedia(args.count, out_dir, rng)
    else:
        got = fetch_picsum(args.count, out_dir, rng, args.width, args.height)

    log(f"\nDone. {got} image(s) ready in {out_dir}")
    if got:
        log("")
        log("Index them with:")
        log(f"  npm run index -- --folder {out_dir} --fake --reset")
        log("")
        log("Use --fake first if you have not run ./scripts/fetch-models.sh yet.")
    return 0 if got else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        log("\ninterrupted")
        sys.exit(130)