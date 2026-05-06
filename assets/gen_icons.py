from PIL import Image
import os

ASSETS = os.path.dirname(os.path.abspath(__file__))

logo   = Image.open(os.path.join(ASSETS, "logo-blue.png"))
logo_w = Image.open(os.path.join(ASSETS, "logo-white.png"))
wmark  = Image.open(os.path.join(ASSETS, "wordmark-blue.png"))

def sq(img, name, size):
    img.resize((size, size), Image.LANCZOS).save(os.path.join(ASSETS, name))
    print("  " + name)

def rect(img, name, w, h):
    img.resize((w, h), Image.LANCZOS).save(os.path.join(ASSETS, name))
    print("  " + name)

# Tray icons — blue (light mode) and white (dark mode), @1x + @2x
print("Tray icons:")
sq(logo,   "tray-icon-16.png",       16)
sq(logo,   "tray-icon-22.png",       22)
sq(logo,   "tray-icon-32.png",       32)   # @2x for 16
sq(logo,   "tray-icon-44.png",       44)   # @2x for 22
sq(logo_w, "tray-icon-16-white.png", 16)
sq(logo_w, "tray-icon-22-white.png", 22)
sq(logo_w, "tray-icon-32-white.png", 32)
sq(logo_w, "tray-icon-44-white.png", 44)

# App / .app bundle icons
print("App icons:")
for sz in [16, 32, 64, 128, 256, 512, 1024]:
    sq(logo, "icon-%d.png" % sz, sz)

# Setup wizard
print("Setup wizard:")
sq(logo, "icon-setup-80.png", 80)
rect(wmark, "wordmark-240.png", 240, int(240 * 2205 / 7180))

# Favicon
print("Favicon:")
sizes = [(16,16),(32,32),(48,48)]
frames = [logo.resize(s, Image.LANCZOS).convert("RGBA") for s in sizes]
frames[0].save(os.path.join(ASSETS, "favicon.ico"),
               format="ICO", sizes=sizes, append_images=frames[1:])
print("  favicon.ico")

print("Done.")
