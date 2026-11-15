"""Builds the Android app's private files for a sample library.

Usage: python android_seed.py BOOKS_DIR OUT_DIR
Writes OUT_DIR/files/{library.json,books/*} and OUT_DIR/shared_prefs/{positions,settings}.xml
"""
import json, os, re, shutil, sys, time, zipfile
from xml.sax.saxutils import escape

books_dir, out = sys.argv[1], sys.argv[2]
os.makedirs(os.path.join(out, "files", "books"), exist_ok=True)
os.makedirs(os.path.join(out, "shared_prefs"), exist_ok=True)


def meta(path):
    try:
        z = zipfile.ZipFile(path)
        opf = next(n for n in z.namelist() if n.endswith(".opf"))
        x = z.read(opf).decode("utf-8", "ignore")
        t = re.search(r"<dc:title[^>]*>(.*?)</dc:title>", x, re.S)
        a = re.search(r"<dc:creator[^>]*>(.*?)</dc:creator>", x, re.S)
        clean = lambda s: re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", s)).strip()
        author = clean(a.group(1)) if a else ""
        # Gutenberg writes "Austen, Jane" → "Jane Austen"
        if re.fullmatch(r"[^,]+, [^,]+", author):
            last, first = author.split(", ")
            author = f"{first} {last}"
        return (clean(t.group(1)) if t else os.path.basename(path)), author
    except Exception:
        return os.path.basename(path), ""


now = int(time.time() * 1000)
progress = [42, 0, 77, 12, 0, 63, 0, 5]
lib, pos = [], {}
for k, name in enumerate(sorted(os.listdir(books_dir))):
    bid = f"b{now - k * 3_600_000}"
    shutil.copy(os.path.join(books_dir, name), os.path.join(out, "files", "books", f"{bid}.epub"))
    title, author = meta(os.path.join(books_dir, name))
    title = title.split(";")[0].split(":")[0].strip()
    lib.append({"id": bid, "title": title, "author": author, "file": f"{bid}.epub", "format": "epub", "added": now - k * 86_400_000})
    pct = progress[k % len(progress)]
    if pct:
        pos[f"pos_{bid}"] = ("int", 1000 * pct // 100)
        pos[f"len_{bid}"] = ("int", 1000)
    pos[f"opened_{bid}"] = ("long", now - k * 3_600_000)

with open(os.path.join(out, "files", "library.json"), "w") as f:
    json.dump(lib, f)


def prefs(path, items):
    rows = []
    for key, (kind, v) in items.items():
        if kind == "string":
            rows.append(f'    <string name="{escape(key)}">{escape(v)}</string>')
        else:
            rows.append(f'    <{kind} name="{escape(key)}" value="{str(v).lower() if kind == "boolean" else v}" />')
    with open(path, "w") as f:
        f.write("<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n" + "\n".join(rows) + "\n</map>\n")


prefs(os.path.join(out, "shared_prefs", "positions.xml"), pos)
prefs(os.path.join(out, "shared_prefs", "settings.xml"), {
    "lastBook": ("string", lib[0]["id"]) if lib else ("string", ""),
    "seenVoiceGuide": ("boolean", True),
    "lastUpdateCheck": ("long", now),
    "libraryView": ("int", 1),
})
print(json.dumps(lib, indent=1))
