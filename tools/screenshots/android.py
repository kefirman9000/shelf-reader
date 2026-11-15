"""Drives the Android app on an emulator with adb and saves screenshots.

Usage: python android.py APK SEED_DIR OUT_DIR
"""
import os, re, subprocess, sys, time
import xml.etree.ElementTree as ET

apk, seed, out = sys.argv[1], sys.argv[2], sys.argv[3]
PKG = "com.shelfreader"
os.makedirs(out, exist_ok=True)


def adb(*a, check=False, timeout=120):
    r = subprocess.run(["adb", *a], capture_output=True, timeout=timeout)
    if check and r.returncode != 0:
        raise RuntimeError(r.stderr.decode())
    return r.stdout.decode("utf-8", "ignore")


def sh(cmd, **kw):
    return adb("shell", cmd, **kw)


def shot(name, wait=1.5):
    time.sleep(wait)
    p = os.path.join(out, f"{name}.png")
    with open(p, "wb") as f:
        f.write(subprocess.run(["adb", "exec-out", "screencap", "-p"], capture_output=True).stdout)
    print("saved", p)


def nodes():
    for _ in range(3):
        sh("uiautomator dump /sdcard/ui.xml", timeout=60)
        x = adb("exec-out", "cat", "/sdcard/ui.xml")
        if "<hierarchy" in x:
            x = x[x.index("<?xml") if "<?xml" in x else 0:]
            return list(ET.fromstring(x[: x.rindex("</hierarchy>") + 12]).iter("node"))
        time.sleep(1)
    return []


def find(text=None, desc=None, exact=False):
    for n in nodes():
        t, d = n.get("text", ""), n.get("content-desc", "")
        ok = (text is not None and (t == text if exact else text in t)) or (desc is not None and (d == desc if exact else desc in d))
        if ok:
            x1, y1, x2, y2 = map(int, re.findall(r"\d+", n.get("bounds")))
            return (x1 + x2) // 2, (y1 + y2) // 2
    return None


def tap(text=None, desc=None, exact=False, wait=1.0):
    c = find(text, desc, exact)
    if not c:
        print("not found:", text or desc); return False
    sh(f"input tap {c[0]} {c[1]}"); time.sleep(wait); return True


def hold(x, y, ms=1100):
    sh(f"input swipe {x} {y} {x} {y} {ms}"); time.sleep(1.2)


def back():
    sh("input keyevent 4"); time.sleep(1)


def step(name, fn):
    try:
        fn()
    except Exception as e:
        print("step failed:", name, e)


size = re.findall(r"(\d+)x(\d+)", sh("wm size"))[-1]
W, H = int(size[0]), int(size[1])
print("screen", W, H)

# install and load the sample library into the app's private storage (debug build allows run-as)
adb("install", "-r", "-g", apk, check=True, timeout=300)
sh(f"pm grant {PKG} android.permission.POST_NOTIFICATIONS")
sh(f"monkey -p {PKG} -c android.intent.category.LAUNCHER 1"); time.sleep(4)
sh(f"am force-stop {PKG}")
adb("push", seed, "/data/local/tmp/seed", check=True, timeout=300)
sh("chmod -R 777 /data/local/tmp/seed")
sh(f"run-as {PKG} sh -c 'mkdir -p files/books shared_prefs && cp -r /data/local/tmp/seed/files/. files/ && cp /data/local/tmp/seed/shared_prefs/*.xml shared_prefs/'")
print(sh(f"run-as {PKG} ls -R files shared_prefs"))

sh(f"am start -n {PKG}/.MainActivity"); time.sleep(8)


def library():
    shot("android-01-library-first-run", 3)
    tap("Got it")
    shot("android-02-library-grid")
    sh(f"input swipe {W // 2} {H * 3 // 4} {W // 2} {H // 3} 400")
    shot("android-03-library-scrolled")
    sh(f"input swipe {W // 2} {H // 3} {W // 2} {H * 3 // 4} 400"); time.sleep(1)
step("library", library)


def book_menu():
    c = find("Frankenstein") or find("Alice") or find("Dracula")
    if c:
        hold(*c); shot("android-04-book-menu"); back()
step("book_menu", book_menu)


def views():
    if tap("Grid ▾"):
        shot("android-05-view-picker", 1); tap("Shelf", exact=True); shot("android-06-library-shelf")
        tap("Shelf ▾"); tap("List", exact=True); shot("android-07-library-list")
        tap("List ▾"); tap("Grid", exact=True)
step("views", views)


def search():
    tap("Find books", exact=True)
    sh("input keyevent 111"); time.sleep(1)  # hide keyboard
    shot("android-08-find-books")
    tap("Jane Austen", exact=True); time.sleep(18)
    shot("android-09-find-books-results")
    sh(f"input tap {W // 2} {H // 2}"); time.sleep(5)
    shot("android-10-book-details")
    back()
step("search", search)


def settings():
    tap("Settings", exact=True)
    shot("android-11-settings")
    sh(f"input swipe {W // 2} {H * 3 // 4} {W // 2} {H // 5} 400")
    shot("android-12-settings-more")
step("settings", settings)


def reader():
    tap("Library", exact=True); time.sleep(1)
    c = find("CONTINUE LISTENING")
    if c:
        sh(f"input tap {W // 3} {c[1] + 40}")
    time.sleep(8)
    shot("android-13-reader-first-open")
    tap("Got it")
    shot("android-14-reader-pages")
    tap("Pages") or tap("Scroll")
    time.sleep(3)
    shot("android-15-reader-scroll")
    hold(W // 2, H // 3)
    shot("android-16-paragraph-menu"); back()
    tap(desc="More", exact=True); shot("android-17-more-menu"); back()
    tap(desc="Text size and look", exact=True); shot("android-18-text-and-look"); back()
    tap(desc="Contents", exact=True); shot("android-19-contents"); back()
    tap("Voice"); time.sleep(3); shot("android-20-voice"); back()
step("reader", reader)


def landscape():
    sh("settings put system accelerometer_rotation 0")
    sh("settings put system user_rotation 1"); time.sleep(4)
    shot("android-21-reader-landscape")
    sh("settings put system user_rotation 0"); time.sleep(2)
step("landscape", landscape)
print("done")
