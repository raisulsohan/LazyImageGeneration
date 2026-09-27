# How it works

What happens between clicking **✨ Generate Image** and the image landing on
your timeline, in plain words. *Written for Lazy-Image 2.6.* The code that
does it is `client/js/browser-bridge.js` (everything up to the download) and
`client/js/main.js` (saving and importing); [Building from
source](development.md) describes the files.

**Contents**

- [The idea](#the-idea)
- [Finding your browser](#finding-your-browser)
- [Starting it without being seen](#starting-it-without-being-seen)
- [Talking to the browser](#talking-to-the-browser)
- [Waiting for ChatGPT](#waiting-for-chatgpt)
- [Sending the prompt](#sending-the-prompt)
- [Recognising the finished image](#recognising-the-finished-image)
- [Downloading it](#downloading-it)
- [Saving and importing](#saving-and-importing)
- [The progress percentage](#the-progress-percentage)
- [Retries, cancelling and cleaning up](#retries-cancelling-and-cleaning-up)
- [The one-time login](#the-one-time-login)
- [Surviving changes to ChatGPT](#surviving-changes-to-chatgpt)

---

## The idea

ChatGPT can make images, and your account already pays for that (or gets a
free allowance). Lazy-Image does not talk to an image API. It does what you
would do by hand, only invisibly: open chatgpt.com in a browser, type the
prompt, wait for the picture, save it. Everything below is about doing that
reliably without a window ever appearing or your keyboard focus leaving
After Effects or Premiere Pro.

The browser used is a **real copy of Chrome or Edge** on your computer,
started on a **profile of its own** (`%APPDATA%\LazyImage\<Browser>Profile`)
so that your everyday browsing is not involved and its cookies, which hold
the ChatGPT login, persist from one generation to the next.

```
Panel (CEP, Node.js)                       Hidden browser (own profile)
  find browser ──► start hidden ──────────► chatgpt.com
  connect (DevTools protocol) ◄──────────── DevToolsActivePort
  wait until logged in and the chat box is there
  type prompt, click Send ────────────────► ChatGPT draws
  poll: new, large, unblurred, settled image?
  fetch image bytes ◄──────────────────────── as base64
  Browser.close ──────────────────────────► exits
  write <project>\chatgptimages\lazy_image_chatgpt_<time>.png
  ExtendScript: import into ChatGptImages, place at the playhead
```

---

## Finding your browser

Lazy-Image asks Windows which browser opens `https://` links: the registry
key `UserChoiceLatest\ProgId` under `Shell\Associations\UrlAssociations\https`
(newer Windows 11 builds keep the current choice there and can leave a stale
value in the older `UserChoice`, so the newer key wins), then the older keys.
The ProgId leads to the browser's `shell\open\command`, and if that
executable is `chrome.exe`, `msedge.exe`, `brave.exe`, `vivaldi.exe` or
`chromium.exe`, that is the browser. Only Chromium browsers speak the
DevTools protocol, so a default of Firefox is skipped.

Without a usable default, the usual install locations of Chrome (Program
Files, Program Files (x86), your local AppData) and then Edge are tried, and
finally Windows' *App Paths* registry entries for `chrome.exe` and
`msedge.exe`. The answer is cached for five seconds.

Each browser gets its own profile folder and its own **login marker**
(`%APPDATA%\LazyImage\.authenticated-edge`, say). That marker is what the
**Logged in** badge shows; it is written whenever ChatGPT loads logged in and
removed whenever it turns out logged out. Switching your default browser
therefore means logging in once more, in the new browser's profile.

---

## Starting it without being seen

The browser is started with:

- `--user-data-dir=` Lazy-Image's profile, so it is separate from yours;
- `--remote-debugging-port=0`, which tells it to pick a free port and write
  it to `DevToolsActivePort` inside the profile;
- `--window-size=1280,900`, because a hidden window still has a size and
  ChatGPT switches to its mobile layout in a narrow one;
- `--no-first-run`, `--no-default-browser-check`,
  `--hide-crash-restore-bubble`, so no welcome or restore dialogs appear;
- three `--disable-…-throttling` flags, so the page keeps working at full
  speed although its window is not visible.

The process is spawned **hidden** (Windows' `SW_HIDE`): no window, no
taskbar button. The page itself still believes it is visible and renders
normally.

**Focus.** A browser activates its first window when it starts, and because
it was launched right after your click it inherits the right to take the
foreground. Even a hidden window would then pull the keyboard focus out of
After Effects. Lazy-Image blocks this with Windows' own
`LockSetForegroundWindow` for the fifteen seconds the browser might be
starting, through a small PowerShell helper. Windows lifts the lock the
moment you click or press a key, so the helper re-asserts it every half
second until the time is up. This is why you can keep typing in the app while
an image is being generated.

**Leftovers.** If the profile's `lockfile` cannot be deleted, a browser is
still running on it (a crash, or an older Lazy-Image); it is closed first.
Twenty seconds without a `DevToolsActivePort` means the start failed and the
half-started process is killed rather than left behind.

---

## Talking to the browser

Chromium browsers are controlled over the **Chrome DevTools Protocol**: a
WebSocket on the port from `DevToolsActivePort`, carrying JSON commands such
as *evaluate this script in the page*, *insert this text*, *press this key*,
*close the browser*. The Node.js inside Adobe's panels has no WebSocket, and
the panel's browser-side WebSocket sends an `Origin` header that the browser's
DevTools server rejects, so Lazy-Image carries a tiny WebSocket client of its
own over a raw TCP socket. It depends on nothing outside Node's standard
library.

The browser's `/json/list` endpoint says which pages are open; Lazy-Image
attaches to the one on chatgpt.com. Everything it then learns about the
page comes from small functions that are sent to the page as source text and
run there: is the login valid, is the chat box present, which images are
new, what does the last reply say.

---

## Waiting for ChatGPT

Once a second, for up to a minute, the page is asked how it is doing:

| The page says | Meaning | Lazy-Image does |
| :--- | :--- | :--- |
| Title *Just a moment* / *Attention required*, or text such as *verify you are human* | Cloudflare's or ChatGPT's human check | Waits up to 30 s for it to pass on its own, then reports **ChatGPT wants a quick human verification** |
| Not finished loading | Slow connection | Waits |
| `/api/auth/session` has no access token | Logged out | Reports **You are not logged in**, and removes the login marker |
| Logged in and the chat box is found | Ready | Goes on |
| Logged in, loaded, but no chat box matches | ChatGPT has changed its page | Waits 20 s in case it is still appearing, then reports **could not find ChatGPT's chat box** |

The login check uses the same session endpoint ChatGPT's own page uses; no
password or token is ever read by Lazy-Image, only *is there a session or
not*.

---

## Sending the prompt

1. **Dialogs.** A visible dialog (a notice about new terms, a tip) is
   dismissed with Escape, twice if needed. One that will not go away is
   reported with its text, so you can deal with it through **Open ChatGPT**.
2. **Typing.** The chat box is focused, anything already in it is selected
   so the new text replaces it, and the prompt is inserted through the
   browser's own text input, so every language and script arrives intact.
   Lines are separated with Shift+Enter, which is ChatGPT's line break; a
   plain Enter might have sent a half-typed prompt. The box is then read
   back and compared with the prompt; if they differ, the prompt is typed
   again as a single line, and if that fails too the generation stops with
   **Could not type the prompt**.
3. **What is sent** is your prompt with a short preamble: *Generate an image
   with aspect ratio 16:9. Do not ask any follow-up questions, create the
   image directly:* followed by your text. Without it ChatGPT sometimes
   answers with a question instead of a picture.
4. **Before sending**, Lazy-Image notes every image already on the page and
   every error text already on screen, and counts your messages in the
   conversation. New things are then told apart from old ones.
5. **Send** is clicked as soon as the button is enabled (it is disabled while
   the box is empty), or failing that End and Enter are pressed. Within
   fifteen seconds either your message shows up in the conversation or the
   reply starts streaming; otherwise Lazy-Image checks whether the chat box
   and send button are still where it expects them and reports either
   **ChatGPT has changed its website** or **ChatGPT did not accept the
   prompt**.

A usage limit or error that ChatGPT shows the moment you send is caught here
too, and reported at once.

---

## Recognising the finished image

Every 1.5 seconds the page is asked for its state, and Lazy-Image looks for
an image that is:

- **new** (not on the page before the prompt was sent);
- **in the conversation**, not in the sidebar, header, form or a dialog;
- **at least 256 × 256 pixels**, which rules out avatars and icons;
- **fully loaded**;
- **not blurred**: ChatGPT shows a blurred preview while it draws, as a CSS
  blur on the image or one of its parents, and that preview is never taken.

The largest such image is the candidate. While ChatGPT still looks busy (the
stop button is showing, a progress bar is on screen, or the text says
*creating image*), the candidate must stay the same for eight polls in a row,
about twelve seconds, so that a partial render is not grabbed. Once the reply
has finished, one sighting is enough.

Meanwhile three other things are watched:

- **ChatGPT's own error text**, such as *you've reached our limit of
  messages*, *unusual activity detected*, *something went wrong*, *error in
  message stream*. Your own prompt is cut out of the scanned text first, so a
  prompt like *a poster saying "something went wrong"* cannot fail itself,
  and text that was already on screen before sending does not count either.
  A hit is reported immediately, in ChatGPT's own words, as a usage limit, a
  flagged session or an error.
- **A refusal**: a finished reply that says *I can't create…*, *I'm unable
  to generate…* or the like will never turn into an image, so it is reported
  at once as **ChatGPT declined to create this image**, with the reply.
- **A text-only reply**: a finished reply with no image and no refusal
  wording gets 45 seconds to grow an image, then is reported as **ChatGPT
  replied without an image**, with the reply.

If nothing has settled after **six minutes**, the wait ends with **No image
arrived within 6 minutes**.

---

## Downloading it

The image is fetched **inside the page**, with the page's own cookies, so
ChatGPT's protected image URLs work. PNG and JPEG are kept as they are.
Anything else (ChatGPT sometimes serves WebP) is redrawn onto a canvas and
re-encoded as PNG, because After Effects cannot import WebP. The bytes come
back to the panel as base64. If the in-page fetch fails, the panel downloads
the URL directly from Node as a fallback; only if both fail do you see **The
image was created but could not be downloaded**.

---

## Saving and importing

The panel asks the app for the open project's file (`app.project.file` in
After Effects, `app.project.path` in Premiere Pro), takes its folder, and
writes `chatgptimages\lazy_image_chatgpt_<timestamp>.<png|jpg>` there,
creating the folder when needed. An unsaved project has no folder, so
`Documents\chatgptimages` is used.

Then one ExtendScript, built for whichever app the panel is in, runs inside
the app:

- **After Effects**: import the file as footage, find or create the
  top-level folder `ChatGptImages` and move the footage into it, take the
  active composition (or the first one in the project when the panel has the
  focus and nothing counts as active), add the footage as a layer and set
  its start to the composition's current time. The whole thing is one undo
  group.
- **Premiere Pro**: find or create the `ChatGptImages` bin, import the file
  into it, find the new item by its media path, read the playhead of the
  active sequence and the still's duration (its in/out points, else five
  seconds). Then look at every video track and find the **highest one that
  has a clip anywhere inside the still's time span**; the target is the
  track above it. If that track does not exist, one is added with Premiere's
  QE layer and the tracks are counted again (Premiere may insert it
  anywhere). The still is placed with an **overwrite into that empty
  space**, first by ticks and, if nothing landed, by seconds. `insertClip`
  is never used because it would ripple every later clip. If no free track
  can be found the item stays in the bin and the status bar says so.

The script returns a short result code and the panel turns it into the
status line you see. Every outcome, including a failed import, produces a
message; the file on disk is never lost.

**The folder watcher.** While the panel is open it watches the current
`chatgptimages` folder. Windows reports deletes, moves to the Recycle Bin
and renames all as one kind of event, and a rename also makes a new name
appear, so events are collected for 400 ms and only net disappearances of
image files are counted. One or more gone: the *Image removed* toast. The
watched folder is re-checked whenever the panel gets the focus, so it
follows you when you switch projects.

---

## The progress percentage

ChatGPT reports no progress, so the percentage is an estimate that is honest
about its stages:

| Stage | Shown |
| :--- | :--- |
| Starting the browser | 2 % |
| Loading ChatGPT | 6 % |
| Sending the prompt | 10 % |
| ChatGPT drawing | 10 % rising towards 95 % |
| Downloading | 97 % |

During the drawing stage the panel remembers how long recent images took.
The first time it assumes 40 seconds. The percentage rises in a straight
line to 95 % of the way over that expected time, then creeps towards 95 %
without ever reaching it, until the image actually arrives. Each finished
image updates the estimate (60 % old, 40 % new, kept between 10 seconds and 5
minutes), so after a few images it matches your account's usual speed.

---

## Retries, cancelling and cleaning up

**One silent retry.** If the browser closed right after starting, closed
mid-way, or ChatGPT showed one of its transient errors (*something went
wrong*, *error in message stream*, a network error), the whole attempt is
made once more after two seconds, with the status *ChatGPT hiccuped — trying
once more…*. Nothing that needs you is retried: not a missing login, a
verification, a usage limit, a refusal, and not a timeout either, since a
second six-minute wait helps nobody.

**Cancel** sets a flag every step checks and closes the browser; whichever
step was waiting stops with *Generation cancelled*.

**Closing the browser.** After every generation, test or login the browser is
asked to close itself (`Browser.close`), which lets it flush its cookies to
disk so the login survives. If it has not exited within six seconds it is
killed. Closing the panel kills any browser it still owns, so a browser can
never be left running behind Lazy-Image.

**One thing at a time.** Generate, Test and Login share one browser and one
*busy* flag; a second request while one is running is refused with a
message rather than starting a second browser.

---

## The one-time login

The login window is the same browser on the same profile, started
**visible** and on ChatGPT's login page, then brought in front of the Adobe
app by minimising and restoring it (the reliable way to raise a new window
over another application on Windows).

Every two seconds the panel looks at the open pages, without ever attaching
to the sign-in provider's pages (Google, Microsoft, Apple, OpenAI's own auth
pages): it only asks a chatgpt.com page whether it now has a session. Seeing
*logged out* and then *logged in* means you have just signed in, and the
window is closed a moment later. Seeing *logged in* from the start means you
already were; the window is then yours until you close it, which is how a
verification or a notice is handled. If you close the window before a login
was seen, a hidden check is run to be sure, and the login is only reported
as incomplete when that check says so.

---

## Surviving changes to ChatGPT

ChatGPT's page changes often. Every element Lazy-Image needs is looked up
through an **ordered list of selectors**, and the first one that matches
wins: the chat box has six candidates (by id, by attribute, any editable
field in the form, a plain textarea), the send button four. A rename on
ChatGPT's side then usually costs nothing. When none match, the panel says
plainly that ChatGPT has most likely changed its website and an update is
needed, instead of failing vaguely or waiting out a timeout. The **🔍 Test**
button reports which of those lookups still resolve, which is the first
thing to run when generations stop working after a ChatGPT redesign.
