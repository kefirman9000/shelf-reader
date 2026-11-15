#!/usr/bin/env bash
# Downloads a few public-domain EPUBs from Project Gutenberg for screenshots.
set -u
out="${1:-books}"
mkdir -p "$out"
for id in 1342 84 11 1661 345 2701 98 174; do
  f="$out/pg$id.epub"
  [ -s "$f" ] && continue
  curl -fsSL --retry 3 -A "ShelfReader-screenshots" -o "$f" \
    "https://www.gutenberg.org/cache/epub/$id/pg$id-images-3.epub" || \
  curl -fsSL --retry 3 -A "ShelfReader-screenshots" -o "$f" \
    "https://www.gutenberg.org/ebooks/$id.epub3.images" || rm -f "$f"
done
ls -la "$out"
