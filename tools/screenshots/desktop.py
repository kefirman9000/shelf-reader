"""Screenshots of the PC app's interface (served by desktop/server.js).

Usage: python desktop.py BOOKS_DIR OUT_DIR   (server must be running on 127.0.0.1:47321)
"""
import json, os, sys, time, urllib.request
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:47321"
books_dir, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)


def api(path, data=None, method=None, headers=None):
    h = {"x-shelf": "1", **(headers or {})}  # the server only accepts changes with this header
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=h)
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read() or b"null")


# import the sample books and give some of them reading progress
progress = [42, 0, 77, 12, 0, 63, 0, 5]
ids = []
for k, name in enumerate(sorted(os.listdir(books_dir))):
    with open(os.path.join(books_dir, name), "rb") as f:
        try:
            b = api("/api/import", f.read(), "POST", {"x-filename": name, "Content-Type": "application/octet-stream"})
        except Exception as e:
            print("import failed", name, e); continue
    ids.append(b["id"])
    d = api(f"/api/book/{b['id']}")  # extracts text, marks as opened
    n = len(d.get("paras", [])) or 1000
    pct = progress[k % len(progress)]
    if pct:
        api(f"/api/state/{b['id']}", json.dumps({"pos": n * pct // 100, "len": n}).encode(), "PUT", {"Content-Type": "application/json"})
    time.sleep(0.05)
# make the first book the one to continue
if ids:
    api(f"/api/book/{ids[0]}")

shots = []


def shot(page, name, full=False):
    time.sleep(1.2)
    p = os.path.join(out, f"{name}.png")
    page.screenshot(path=p, full_page=full)
    shots.append(p)
    print("saved", p)


def step(name, fn):
    try:
        fn()
    except Exception as e:
        print("step failed:", name, e)


with sync_playwright() as pw:
    br = pw.chromium.launch()
    ctx = br.new_context(viewport={"width": 1440, "height": 900}, color_scheme="dark", device_scale_factor=1)
    page = ctx.new_page()
    page.goto(BASE + "/", wait_until="networkidle")
    time.sleep(3)

    def library():
        page.select_option("#viewSel", "0"); shot(page, "pc-01-library-shelf")
        page.select_option("#viewSel", "1"); shot(page, "pc-02-library-grid")
        page.select_option("#viewSel", "2"); shot(page, "pc-03-library-list")
        page.select_option("#viewSel", "1")
    step("library", library)

    def search():
        page.click(".tab[data-view=search]")
        shot(page, "pc-04-find-books-empty")
        page.fill("#q", "Jane Austen")
        page.press("#q", "Enter")
        page.wait_for_timeout(15000)
        shot(page, "pc-05-find-books-results")
        page.click(".tab[data-view=library]")
    step("search", search)

    def reader():
        page.click("#contOpen")
        page.wait_for_timeout(4000)
        shot(page, "pc-06-reader-book-pages")  # book pages is the default layout
        page.click("#layoutBtn"); page.wait_for_timeout(2500)
        shot(page, "pc-07-reader-scroll")
        page.click("#layoutBtn"); page.wait_for_timeout(1500)
        page.click("#chapBtn"); page.wait_for_timeout(1500)
        shot(page, "pc-08-chapters")
        page.keyboard.press("Escape")
        page.click("#drawerClose", timeout=3000)
    step("reader", reader)

    def settings():
        page.goto(BASE + "/", wait_until="networkidle"); time.sleep(2)
        page.click("#settingsBtn"); page.wait_for_timeout(1500)
        shot(page, "pc-09-settings")
    step("settings", settings)

    def maker():
        page.goto(BASE + "/maker.html", wait_until="networkidle"); time.sleep(3)
        shot(page, "pc-10-audiobook-maker")
    step("maker", maker)

    def small_window():
        page.set_viewport_size({"width": 900, "height": 700})
        page.goto(BASE + "/", wait_until="networkidle"); time.sleep(2)
        shot(page, "pc-11-small-window")
    step("small", small_window)
    br.close()
print(len(shots), "screenshots")
