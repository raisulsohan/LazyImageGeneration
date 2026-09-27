# Building from source

How Lazy-Image is put together, the rules its code keeps, how to run it from
a clone and how a release is built. *Written for Lazy-Image 2.6.*

**Contents**

- [How it fits together](#how-it-fits-together)
- [Repository layout](#repository-layout)
- [Running it from the repository](#running-it-from-the-repository)
- [Rules the code keeps](#rules-the-code-keeps)
- [The browser bridge API](#the-browser-bridge-api)
- [The host scripts](#the-host-scripts)
- [Testing](#testing)
- [The documentation screenshots](#the-documentation-screenshots)
- [Building a release](#building-a-release)
- [Publishing a version](#publishing-a-version)

---

## How it fits together

Lazy-Image is a standard **CEP extension**: an HTML/JavaScript panel running
in Adobe's embedded Chromium with Node.js enabled, plus ExtendScript that
runs inside the host app. What makes it unusual is the third party in the
room, a hidden copy of the user's own browser, which the panel drives over
the Chrome DevTools Protocol.

```
┌──────────── client/  (CEP Chromium + Node, mixed context) ─────────────────────────────┐
│ index.html, css/style.css   the panel: header, prompt, ratios, preview, status bar     │
│ js/main.js                  UI state, progress estimate, saving the file, the folder   │
│                             watcher, and the ExtendScript import for each host         │
│ js/browser-bridge.js        finds and launches the browser, CDP client, the ChatGPT    │
│                             flow (login, test, generate), error codes, cleanup         │
│ js/utils/storage.js         localStorage wrapper                                       │
└──────┬──────────────────────────────────────────┬──────────────────────────────────────┘
       │ CSInterface.evalScript(script)           │ spawn + DevTools WebSocket (127.0.0.1)
       ▼                                          ▼
┌────── host  (ExtendScript, ES3) ──────┐   ┌────── Chrome / Edge / Brave / Vivaldi ───────┐
│ After Effects: import into the        │   │ own profile in %APPDATA%\LazyImage           │
│ ChatGptImages folder, layer at        │   │ hidden window (SW_HIDE), remote debugging    │
│ comp.time, one undo group             │   │ port 0, foreground locked while starting     │
│ Premiere Pro: import into the bin,    │   │ page scripts run inside chatgpt.com:         │
│ overwrite onto the first free track   │   │ session check, type, send, watch images,     │
│ above the clips, add a track if needed│   │ fetch the image as base64                    │
└───────────────────────────────────────┘   └──────────────────────────────────────────────┘
```

The panel does everything it can itself: finding the browser, driving
ChatGPT, saving the file. It asks the host app only for two things: where the
project file is, and to import and place the finished image. [How it
works](how-it-works.md) walks through the whole flow in plain words.

The manifest (`CSXS/manifest.xml`) targets **AEFT 16.0+** (After Effects CC
2019) and **PPRO 13.0+** (Premiere Pro CC 2019), requires **CSXS 9**, and
starts the panel with `--enable-nodejs --mixed-context`. The menu entry is
**Lazy-Image** in both apps; the bundle id is `com.gimage.aftereffects` (kept
from 1.x so updates replace the old install). Default size 820 × 600,
resizable from 650 × 450 to 1400 × 900.

---

## Repository layout

```
LazyImageGeneration/
├── CSXS/manifest.xml            Extension ID, hosts, panel size, Node flags
├── client/
│   ├── index.html               Panel markup (scripts load in order: CSInterface, storage, browser-bridge, main)
│   ├── css/style.css            Dark theme in the apps' style
│   └── js/
│       ├── CSInterface.js       Adobe's CEP bridge (Adobe's licence, not MIT)
│       ├── browser-bridge.js    Browser discovery, CDP client, the ChatGPT flow  (window.BrowserBridge)
│       ├── main.js              Panel controller, saving, import scripts for both hosts
│       └── utils/
│           ├── storage.js       localStorage wrapper (GImageStorage)
│           └── fileManager.js   Left over from 1.x; not loaded by index.html
├── host/index.jsx               ExtendScript loaded by the manifest (two After Effects helpers from 1.x)
├── assets/                      README media: preview-v2.png, demo.gif, demo.mp4
├── docs/                        This documentation, with its screenshots in docs/images/
├── tools/
│   ├── installer/               What ships beside the .zxp: install.bat, uninstall.bat,
│   │                            "Fix a blank panel.bat", installguide.txt
│   ├── docs-screenshots/        shot.html: the panel in each documented state, for the screenshots
│   ├── get-zxpsigncmd.mjs       Downloads Adobe's ZXPSignCmd into tools/vendor/ (git-ignored)
│   ├── package-zxp.mjs          Syncs the version, signs the panel, builds the release zip
│   └── zip.mjs                  Small ZIP writer
├── install.bat                  Developer install: links this folder into Adobe's CEP folder
├── .debug                       Remote-debugging ports for the panel (AE 8089, Premiere 8090); not shipped
├── CHANGELOG.md
├── LICENSE                      MIT
└── package.json                 Version source and npm scripts
```

Two folders are deliberately absent from git: `Signing key (do not share)/`
(the release certificate and its password) and `tools/vendor/` (Adobe's
signing tool). Both are listed in `.gitignore`; the key is also in
`.git/info/exclude`, which no commit can change.

---

## Running it from the repository

The repository folder **is** the extension, so it can be linked straight into
Adobe's extensions folder.

1. If the signed release is installed, remove it first with its
   `uninstall.bat` (the developer installer cannot replace a real folder).
2. Double-click **`install.bat`** in the repository root. It turns on Adobe's
   `PlayerDebugMode` for CSXS 9 to 13 in your user's registry, which lets the
   apps load an unsigned panel, and creates a directory junction
   `%APPDATA%\Adobe\CEP\extensions\com.gimage.aftereffects` pointing at the
   clone.
3. Start After Effects or Premiere Pro and open **Window › Extensions ›
   Lazy-Image**.

Edits to `client/` show up when you close and reopen the panel. With
`PlayerDebugMode` on, `.debug` also opens Chromium's remote debugging for the
panel: browse to `http://localhost:8089` (After Effects) or
`http://localhost:8090` (Premiere Pro) in Chrome to get DevTools for the
panel, with its console and Node access.

Do not keep the junction and the signed install side by side; they are the
same folder name. The release installer knows the difference: it removes a
junction with a plain `rmdir`, which never touches the folder it points at.

---

## Rules the code keeps

**Windows only, on purpose.** The bridge reads the default browser from the
registry, locks the foreground through PowerShell, closes stale browsers with
`Get-CimInstance` and `taskkill`, and puts images on the clipboard with
`System.Windows.Forms`. A macOS port would need each of these replaced; the
manifest does not exclude macOS, so the panel would open there and fail at
the first browser launch.

**No dependencies.** `package.json` lists none; `npm install` fetches
nothing. The panel uses only Node's standard library (`child_process`,
`net`, `http`, `https`, `crypto`, `fs`, `path`, `os`), including its own
WebSocket framing for the DevTools connection. This keeps the signed panel
small and its supply chain empty.

**Page scripts are sent as source.** Every function that runs inside
chatgpt.com (`pageLoadState`, `pageGenerationState`, …) is turned into text
with `Function#toString` and evaluated in the page. They must therefore be
**self-contained**: no closures over the bridge's variables, everything they
need passed as the one JSON argument (`PAGE_HOOKS`, an image URL). The two
bits of state they keep between calls (`__lazyImageBefore`,
`__lazyFailureBefore`) live on the page's `window`.

**Selectors are lists.** Anything looked up in ChatGPT's page goes through
`PAGE_HOOKS`, an ordered list per element; the first match wins. Add a new
candidate to the list when ChatGPT renames something, never a bare
`querySelector` elsewhere.

**Failure text is matched outside the user's own words.** The failure
patterns (usage limit, unusual activity, stream error) are searched in the
page text with every user message cut out, and anything already on screen
before the prompt was sent is ignored. A prompt cannot fail itself and an
old error cannot fail a new run.

**Errors carry a code.** The bridge throws `Error` objects with a `code`
(table below). `main.js` decides from the code how to show it: `CANCELLED`
quietly, the `NEEDS_YOU` codes in orange, the rest in red. `RETRYABLE` codes
are tried once more. Any new failure needs a code, not just a message.

**Never leave a browser behind.** Every path that starts a browser ends in
`closeBrowser` in a `finally`; a half-started browser is force-killed; panel
unload calls `shutdown()`, which kills synchronously. `Browser.close` is
preferred so cookies flush and the login survives.

**One task at a time.** `begin()`/`end()` guard `generate`, `login`,
`checkLogin` and `diagnose` with a single `busy` flag, so two browsers are
never started on the same profile.

**ExtendScript is ES3.** The import scripts in `main.js` and `host/index.jsx`
avoid anything newer: `var`, no trailing commas, no `indexOf` on arrays,
JSON built by hand. Paths are escaped before being placed in the script.
Premiere's optional QE layer is wrapped in `try` so a version without it
still imports into the bin.

**Old hosts.** The manifest allows CEP 9 (After Effects 2019, Premiere Pro
2019), whose Chromium and Node are years old. The panel code uses `async` /
`await`, classes and template strings, which they support; anything newer
needs a fallback or a raised minimum in the manifest. Test in the oldest app
you can get hold of.

---

## The browser bridge API

`window.BrowserBridge`, defined in `client/js/browser-bridge.js`. Everything
is `async` unless noted.

| Function | Does / returns |
| :--- | :--- |
| `generate(prompt, aspectRatio, onProgress)` | The whole flow, with one silent retry for `RETRYABLE` codes. Resolves `{ success: true, imageBase64, format: 'png' \| 'jpg' \| 'webp', dimensions: 'WxH', provider: 'chatgpt' }`. `onProgress(message, stage)` with stages `launch`, `load`, `send`, `create`, `download`. |
| `login(onProgress)` | Opens the visible login window. `onProgress` gets `'opened'`, `'already'`, `'verifying'`. Resolves `{ loggedIn }`. |
| `checkLogin()` | Hidden login check. Resolves `true` / `false`. |
| `diagnose()` | The Test button. Resolves `{ browserName, loggedIn, composer, send, error }`, where `composer` and `send` are the selectors that matched, or `null`. Never rejects. |
| `cancel()` | Sets the cancel flag and closes the browser. Synchronous. |
| `shutdown()` | Force-kills any owned browser. Synchronous; for `beforeunload`. |
| `getStatus()` | Synchronous `{ loggedIn, browserName, busy, browserOpen, windowVisible }`. `loggedIn` reads the per-browser marker file, not the live session. |
| `findBrowser()` | Synchronous `{ exe, id, name, profileDir }` or `null`; cached 5 s. |
| `isAuthenticated(browser?)` | Synchronous marker check. |

### Error codes

| Code | When | Shown as | Retried |
| :--- | :--- | :--- | :--- |
| `BROWSER_NOT_FOUND` | No Chromium browser found | red | no |
| `LAUNCH_FAILED` | No `DevToolsActivePort` in 20 s, exited at once, or no chatgpt.com page in 15 s | red | yes |
| `BROWSER_CLOSED` | The browser exited mid-flow | red | yes |
| `CHATGPT_ERROR` | ChatGPT's own error text (*something went wrong*, stream/network error, *conversation not found*) | red | yes |
| `NOT_LOGGED_IN` | `/api/auth/session` has no token | orange | no |
| `CHALLENGE` | Human check on screen for 30 s | orange | no |
| `DIALOG` | A dialog survived two Escapes | orange | no |
| `RATE_LIMIT` | Usage-limit text | orange | no |
| `CHATGPT_BLOCKED` | *Unusual activity* text | orange | no |
| `UI_CHANGED` | No chat box for 20 s, or chat box / send button missing when a send fails | orange | no |
| `NO_IMAGE` | A refusal, or a finished text-only reply for 45 s | orange | no |
| `TIMEOUT` | Page not ready in 60 s, no image in 6 min, or a CDP command unanswered | red | no |
| `SEND_FAILED` | Prompt not typed, or not accepted in 15 s | red | no |
| `DOWNLOAD_FAILED` | Both the in-page fetch and the direct download failed | red | no |
| `BUSY` | Another task holds the bridge | red | no |
| `CANCELLED` | `cancel()` was called | quiet | no |

### Timeouts

| Constant | Value | Guards |
| :--- | :--- | :--- |
| `LAUNCH_TIMEOUT_MS` | 20 s | Browser start to `DevToolsActivePort` |
| `READY_TIMEOUT_MS` | 60 s | chatgpt.com to a usable, logged-in page |
| `CHALLENGE_TIMEOUT_MS` | 30 s | A human check left on screen |
| `UI_CHANGED_GRACE_MS` | 20 s | Logged in, but no chat box yet |
| `TEXT_ONLY_REPLY_MS` | 45 s | A finished reply without an image |
| `GENERATION_TIMEOUT_MS` | 6 min | Send to a settled image |
| `LOGIN_TIMEOUT_MS` | 15 min | The visible login window |

---

## The host scripts

The panel builds the ExtendScript it needs in `main.js` and runs it with
`csInterface.evalScript`, so one JavaScript file can serve both apps and the
script can carry the escaped file path.

| Script | Host | Returns |
| :--- | :--- | :--- |
| project file lookup | After Effects: `app.project.file.fsName`; Premiere Pro: `app.project.path` | The path, or `""` for an unsaved project |
| `buildAfterEffectsImportScript(path)` | After Effects | `SUCCESS\|<comp>`, `SUCCESS_PROJECT`, `FILE_NOT_FOUND`, `IMPORT_FAILED`, `ERROR\|<message>` |
| `buildPremiereImportScript(path)` | Premiere Pro | `SUCCESS\|<sequence>`, `SUCCESS_BIN_ONLY\|<sequence>`, `SUCCESS_PROJECT`, `IMPORT_FAILED`, `ERROR\|<message>` |

The After Effects script wraps import and layer in the undo group
*Lazy-Image: Auto Import*, finds or creates the `ChatGptImages` folder by a
case-insensitive name match, and targets `app.project.activeItem` when it is
a composition, else the first `CompItem` in the project.

The Premiere Pro script imports with `importFiles([path], true, bin, false)`,
finds the new item by comparing `getMediaPath()` with the file path (slashes
and case normalised), takes the playhead from `getPlayerPosition()` and the
still's duration from its in/out points (5 s if unusable). `topBusyTrack`
returns the highest video track with a clip overlapping the still's span; a
track whose `clips.numItems` is not a number is treated as busy. The target
is the track above; if it does not exist, `qe.project.getActiveSequence()
.addTracks(1, trackCount, 0)` adds one and the sequence is re-read, because
Premiere may insert the track anywhere. `overwriteClip` is tried with ticks
and then with seconds, and success is judged by the track's clip count
changing. `insertClip` is never used: it would ripple later clips.

`host/index.jsx`, which the manifest loads as `ScriptPath`, keeps two After
Effects helpers from 1.x (`importImageToActiveComp`, `getActiveCompInfo`)
with a hand-rolled JSON serialiser. The panel does not call them; they are
harmless and stay for anyone scripting against them.

---

## Testing

There is no automated test suite. The panel's value lies in driving a live
website through a real browser inside two Adobe apps, and none of the three
can be faked convincingly; `AfterFX.com -r` runs scripts but not CEP panels.
A change is therefore checked **by hand**, in both apps, before it is
released:

1. **Fresh profile.** Delete `%APPDATA%\LazyImage`, open the panel: badge
   *Login required*. Login: window opens in front, closes by itself after
   signing in, badge *Logged in*.
2. **Test** reports all four checks found.
3. **Generate** in After Effects with a saved project and an open comp: no
   window, no focus change while typing in the app, image in
   `chatgptimages`, in the `ChatGptImages` folder, layer at the playhead,
   one Ctrl+Z removes it.
4. **Generate** in Premiere Pro over a busy timeline: still lands on the
   track above the clips, nothing moves; with every track busy at the top, a
   track is added.
5. **No comp / sequence open**: the *open a comp* status, item in the
   project.
6. **Unsaved project**: image in `Documents\chatgptimages`.
7. **Cancel** mid-generation: browser gone from Task Manager, status
   *Generation cancelled*.
8. **Close the panel** mid-generation: browser gone.
9. **Failure texts**: a deliberately declined prompt shows the refusal; a
   prompt that is only a question shows *replied without an image*.
10. **Delete an image** from the folder: the toast.
11. **Copy Image** pastes into Photoshop; **Open Folder** opens Explorer.

For the ChatGPT page logic, DevTools on the panel (`http://localhost:8089`
with `PlayerDebugMode`) shows the bridge's console. The hidden browser itself
can be inspected while a generation runs: read the port from
`%APPDATA%\LazyImage\<Browser>Profile\DevToolsActivePort` and open
`http://127.0.0.1:<port>/json/list` for its pages, or attach Chrome's
`chrome://inspect` to that port.

---

## The documentation screenshots

The pictures in `docs/images/` are the panel's own markup and stylesheet,
rendered by a headless browser at the panel's default size and twice the
pixel density, so they stay pixel-true to what the apps show and can be
remade after any change to the panel.

`tools/docs-screenshots/shot.html` is `client/index.html` with the panel's
scripts replaced by one that puts the DOM into a documented state, using the
same class names and strings as `main.js`. The state is chosen with
`?state=`:

| State | Shows |
| :--- | :--- |
| `login-required` | A fresh panel |
| `login-window` | The login window open: *Browser open*, *Waiting for login…* |
| `logged-in` | Just logged in |
| `test` | The Test report, all four checks found |
| `generating` | Mid-generation at 46 %, Cancel showing |
| `result-ae` | An image placed in *Main Comp* (After Effects) |
| `result-premiere` | The same in *Sequence 01* (Premiere Pro) |
| `bin-only-premiere` | Premiere Pro with no free track |
| `no-comp` | No composition open |
| `custom-ratio` | Custom aspect ratio 21:9 |
| `verification` | The human-verification warning |
| `toast` | The *Image removed* toast |

Render one with Edge or Chrome (the spinners are frozen by the page so they
photograph well):

```bat
"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --headless=new --disable-gpu --hide-scrollbars --window-size=820,600 --force-device-scale-factor=2 --virtual-time-budget=10000 --user-data-dir=%TEMP%\lazy-image-shots --screenshot=docs\images\result-ae.png "file:///D:/path/to/LazyImageGeneration/tools/docs-screenshots/shot.html?state=result-ae"
```

The header, status bar, aspect-ratio and toast pictures are crops of those
full frames (1640 × 1200): the header is the top 150 px; the status bars are
the right column, `x` 672 to 1608, around the bar; the custom ratio is the
left column, `x` 0 to 660, `y` 800 to 1050. The preview image, `apple.png`,
is a genuine Lazy-Image result cropped from the 2.0 README screenshot.

---

## Building a release

```bash
npm run release:cert   # once: creates the self-signed signing certificate
npm run release        # signs the panel and writes the zip
```

Both scripts first run `tools/get-zxpsigncmd.mjs`, which downloads Adobe's
ZXPSignCmd (4.1.3, from Adobe's CEP-Resources repository) into
`tools/vendor/` if it is not there yet. `ZXPSIGNCMD` points at a copy
elsewhere.

`tools/package-zxp.mjs` then:

1. **Syncs the version** from `package.json` into the manifest (both
   version attributes), the panel header (`v2.6`), and the README (the
   version line and the zip file name). `2.6.0` is shown as `2.6`; `2.6.1`
   stays `2.6.1`.
2. **Stages** `CSXS/`, `client/` and `host/` in a temp folder, skipping
   `.debug`, `node_modules` and OS litter, checks the five files the panel
   cannot run without are present, and refuses any symlink (Adobe's
   signature check breaks on them, which shows as a blank panel).
3. **Signs** with the certificate in `Signing key (do not share)/`
   (`lazy-image.p12` + `password.txt`; `LAZYIMAGE_KEY_DIR` and
   `LAZYIMAGE_CERT_PASSWORD` override), timestamped by DigiCert, then
   Certum, then Sectigo. A timestamp is what keeps the panel loading after
   the certificate expires; if no server answers it signs without one and
   says so loudly.
4. **Verifies** the `.zxp` and prints the certificate.
5. **Assembles** the download folder: the `.zxp` plus everything in
   `tools/installer/`, with `.bat` and `.txt` files rewritten to CRLF line
   endings (cmd.exe misreads LF-only batch files).
6. **Zips** it as `Lazy-Image-v<version>-Windows.zip` into the nearest
   folder named `00. Install from here` beside the repository or any folder
   above it (made beside the repository if none exists;
   `LAZYIMAGE_DOWNLOAD_DIR` overrides), deleting older Lazy-Image zips
   there so only the newest remains.

The certificate is self-signed (publisher *Raisul Sohan*, organisation
*Lazy-Image*, ten years). **Every release must be signed with the same
certificate**, or Adobe treats the update as a different publisher, so the
key folder is backed up privately and never committed. `--cert` refuses to
overwrite an existing key without `--force`.

---

## Publishing a version

1. Set the new version in `package.json` and add its entry to
   `CHANGELOG.md` and the README's *What's New*.
2. `npm run release`, which also syncs the version into the manifest, the
   panel and the README.
3. Run through the [testing list](#testing) with the zip's `install.bat`,
   not the junction.
4. Commit as *Release X.Y: …*, tag `vX.Y`, push both.
5. Create the GitHub release from the tag, titled *Lazy-Image X.Y — …*, with
   the zip attached and its SHA-256 in the notes, under *Download & install*
   and *What's new*.
