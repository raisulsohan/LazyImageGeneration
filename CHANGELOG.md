# Changelog

All notable changes to Lazy-Image. Versions follow `package.json`; each
release is tagged `vX.Y` and published on the
[releases page](https://github.com/raisulsohan/LazyImageGeneration/releases).

## Unreleased

- **Documentation:** new `docs/` folder with the manual, how it works,
  troubleshooting (including every status bar message) and building from
  source. This changelog. The README links to them.
- The README shows the demo animation (`assets/demo.gif`, linking to the
  1080p60 `assets/demo.mp4`).
- The release script finds the `00. Install from here` download folder from
  inside a collection folder too.

## 2.6 — 2026-09-16

- **Signed installer.** The download is a signed and timestamped `.zxp` with
  a one-click `install.bat`, so Adobe loads the panel without its developer
  debug mode and without an extension manager. `tools/package-zxp.mjs` signs
  with Adobe's ZXPSignCmd, verifies the package and builds the zip.
- **`uninstall.bat`** removes the panel and asks before removing the saved
  ChatGPT login (`%APPDATA%\LazyImage`) as well. Generated images are never
  touched.
- **`Fix a blank panel.bat`** for computers where Adobe's signature check
  fails even for a correctly signed panel: it turns on Adobe's own
  *PlayerDebugMode* for the current user.
- The obfuscating build and its dependency were dropped: the source is
  public, so the release is the same code as the repository.

## 2.5 — 2026-09-16

- **Free forever.** The activation screen, the licence check
  (`client/js/license.js`), the *Deactivate* button and the seller tools are
  gone. The panel contacts nothing but ChatGPT.
- **Ready-made download.** Every release comes with a zip and an installer;
  no Git needed.
- MIT licence added to the repository.

## 2.4 — 2026-09-12

- For a short time Lazy-Image was sold with an activation key (verified
  online through the shop that sold it, or offline for keys sent by email,
  two computers per key, with a 14-day grace period when the server could
  not be reached). 2.5 removed all of it four days later and the tool has
  been free since. The tag remains for the record.

## 2.3 — 2026-09-11

- **Says what actually went wrong.** ChatGPT's own error text (a usage
  limit, *something went wrong*, an *unusual activity* flag) is detected and
  reported at once, in ChatGPT's words, instead of waiting out the six-minute
  timeout. The user's own prompt is cut out of the scanned text first, and
  text already on screen is ignored, so a prompt cannot fail itself.
- **Refusals stop the wait.** A finished reply saying *I can't create…* is
  reported immediately as a declined image.
- **Survives ChatGPT changes better.** Every element is looked up through an
  ordered list of fallback selectors; when none match, the panel says ChatGPT
  has changed its website and an update is needed.
- **🔍 Test button** and `BrowserBridge.diagnose()`: browser, login, chat box
  and send button checked in a few seconds without sending anything.
- **One automatic retry** after a transient browser or ChatGPT error.
- The foreground lock is re-asserted every half second while the browser
  starts, so a click at the wrong moment cannot let the hidden window take
  the keyboard focus.

## 2.2 — 2026-09-11

- **Premiere Pro support.** The same panel runs in Premiere Pro (host
  `PPRO`, debug port 8090); the header shows which app it is in.
- In Premiere Pro the project folder comes from `app.project.path`, images
  are imported into a `ChatGptImages` bin and placed at the playhead on the
  first video track above the clips they would cover, adding a track when
  needed. Clips are never overwritten; with no free track the image stays in
  the bin.
- A status message for every import outcome, including failures.
- The menu entry is **Lazy-Image** in both apps.

## 2.1 — 2026-09-11

- **Uses the Windows default browser** when it is Chromium-based (Chrome,
  Edge, Brave, Vivaldi), reading the newer `UserChoiceLatest\ProgId`
  registry key first; falls back to Chrome, then Edge.
- **`ChatGptImages` folder** in the After Effects Project panel collects
  every imported image.
- **Progress percentage** while ChatGPT draws, estimated from how long recent
  images took.

## 2.0 — 2026-09-11

- **Invisible, on-demand browser.** The Chrome companion extension and its
  local HTTP bridge from 1.x are gone. For each image the panel starts the
  browser itself with a hidden window on a dedicated profile, drives ChatGPT
  over the Chrome DevTools Protocol with a built-in WebSocket client, and
  closes it right after. No taskbar button, no background process.
- **One-time login** in a normal browser window that closes by itself once
  the login is seen.
- **Never steals keyboard focus** from After Effects: the foreground is
  locked while the browser starts.
- **`chatgptimages` folder** next to the project file (was `AI_Generated`),
  with an *Image removed* toast when an image is deleted from it.
- **✕ Cancel** stops a running generation.
- Updated for ChatGPT's current web interface.

## 1.x — 2026-08-24 to 2026-09-05

- First public version, After Effects only. The panel hosted a small local
  HTTP server, and a companion Chrome extension (Manifest V3) relayed
  prompts to the user's open ChatGPT tab and sent the image back. Images
  were saved in an `AI_Generated` folder next to the project and added to
  the active composition at the playhead. Aspect ratio presets, custom
  ratios, Copy Image and Open Folder date from here.
