/*
 * Package Lazy-Image as a signed ZXP, wrapped in a zip a user can unzip and
 * install with one double-click.
 *
 *   node tools/package-zxp.mjs --cert     make the signing certificate (once)
 *   node tools/package-zxp.mjs            sign and package
 *
 * Adobe's own ZXPSignCmd does the signing; tools/get-zxpsigncmd.mjs fetches it.
 * The key that signs it sits in the repository folder but never in git — this
 * repository is public (see `certDir`). The finished zip goes to a downloads
 * folder beside the repository; the half-built pieces go to the system temp
 * folder and are swept up at the end.
 *
 * It works the same way as LazyLord's release script, so both install alike.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { walk, writeZip } from "./zip.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
/* 2.6.0 reads as 2.6 in the zip name and the panel footer; 2.6.1 stays 2.6.1. */
const SHORT = VERSION.replace(/\.0$/, "");

/*
 * The signing key lives in the repository folder, in "Signing key (do not
 * share)", kept out of git twice over: .gitignore and .git/info/exclude (which
 * no commit can change). LAZYIMAGE_KEY_DIR overrides where it is.
 *
 * The finished zip goes to "00. Install from here" (D:\GitHub\00. Install from
 * here), which keeps only the newest Lazy-Image zip: the nearest folder of that
 * name beside the repository or beside any folder above it, so the repository
 * can sit inside a collection folder (D:\GitHub\01. After Effects Tools\LazyImageGeneration).
 * Without one, it is made beside the repository. LAZYIMAGE_DOWNLOAD_DIR
 * overrides it.
 */
function downloadsFolder() {
  const name = "00. Install from here";
  for (let dir = resolve(root, ".."); ; dir = dirname(dir)) {
    if (existsSync(join(dir, name))) return join(dir, name);
    if (dirname(dir) === dir) return resolve(root, "..", name);
  }
}
const downloads = process.env.LAZYIMAGE_DOWNLOAD_DIR || downloadsFolder();
const certDir = process.env.LAZYIMAGE_KEY_DIR || join(root, "Signing key (do not share)");
const p12 = join(certDir, "lazy-image.p12");
const pwFile = join(certDir, "password.txt");

/* Everything half-built goes to a scratch folder and is swept up after. */
const work = join(tmpdir(), `lazy-image-build-${VERSION}`);
const staging = join(work, "com.gimage.aftereffects");
const payload = join(work, "Lazy-Image");
const zxpName = `Lazy-Image-${VERSION}.zxp`;
const zxp = join(work, zxpName);
const zipName = `Lazy-Image-v${SHORT}-Windows.zip`;

/* Who the installer names as the publisher. */
const CERT = {
  country: "BD",
  state: "Dhaka",
  organisation: "Lazy-Image",
  commonName: "Raisul Sohan",
  validityDays: "3650",
};

/*
 * A timestamp is what keeps a signed extension working after the certificate
 * expires, so it is worth trying more than one server before giving up.
 */
const TIMESTAMP_SERVERS = [
  "http://timestamp.digicert.com",
  "http://time.certum.pl/",
  "http://timestamp.sectigo.com",
];

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);

function log(step, message) {
  console.log(`${step}  ${message}`);
}

function fail(message) {
  console.error(`\n[!] ${message}\n`);
  process.exit(1);
}

/* ---------------------------------------------------------------- the tool */

function signTool() {
  const named = process.env.ZXPSIGNCMD;
  const exe = process.platform === "win32" ? "ZXPSignCmd.exe" : "ZXPSignCmd";
  const candidates = [named, join(root, "tools", "vendor", exe), exe].filter(Boolean);
  for (const candidate of candidates) {
    try {
      /* Printing its usage is how ZXPSignCmd answers a call with no work to
         do, and it exits non-zero while doing it — so the test is the text. */
      execFileSync(candidate, ["-h"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return candidate;
    } catch (error) {
      const said = `${error.stdout || ""}${error.stderr || ""}`;
      if (said.includes("ZXPSignCmd -sign")) return candidate;
    }
  }
  fail(
    "ZXPSignCmd was not found. Run `node tools/get-zxpsigncmd.mjs` to download\n" +
    "    Adobe's signing tool into tools/vendor/, or set ZXPSIGNCMD to its path.",
  );
}

function run(tool, argv) {
  return execFileSync(tool, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/* -------------------------------------------------------- the certificate */

function password() {
  if (process.env.LAZYIMAGE_CERT_PASSWORD) return process.env.LAZYIMAGE_CERT_PASSWORD;
  if (existsSync(pwFile)) return readFileSync(pwFile, "utf8").trim();
  mkdirSync(certDir, { recursive: true });
  /* Letters and digits only: this is passed on a command line. */
  const made = randomBytes(32).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 24);
  writeFileSync(pwFile, made + "\n");
  log("[cert]", `wrote a new password to ${pwFile} — keep it, and keep it out of git`);
  return made;
}

function makeCert(tool) {
  if (existsSync(p12) && !has("--force")) {
    fail(
      `${p12} already exists.\n` +
      "    Signing every release with the same certificate keeps the publisher the\n" +
      "    same from one version to the next, so this is not overwritten by accident.\n" +
      "    Pass --force if you really mean to start a new identity.",
    );
  }
  mkdirSync(certDir, { recursive: true });
  const pw = password();
  run(tool, [
    "-selfSignedCert",
    CERT.country, CERT.state, CERT.organisation, CERT.commonName,
    pw, p12,
    "-validityDays", CERT.validityDays,
  ]);
  if (!existsSync(p12)) fail("ZXPSignCmd did not produce the certificate.");
  log("[cert]", `${p12} — ${CERT.commonName}, ${CERT.organisation} (${CERT.validityDays} days)`);
  console.log(
    `\nBack up "${certDir}" somewhere private (not GitHub — this repository is public).\n`,
  );
}

/* ------------------------------------------------------------ the package */

/*
 * package.json holds the version; the manifest, the panel footer and the
 * README each carry a copy. Adobe decides whether an install is an update by
 * comparing the manifest version, so they are kept in step here rather than by
 * memory.
 */
function syncVersion() {
  const edits = [
    {
      file: "CSXS/manifest.xml",
      find: /(ExtensionBundleVersion|Extension Id="com\.gimage\.aftereffects" Version)="[\d.]+"/g,
      to: `$1="${VERSION}"`,
    },
    { file: "client/index.html", find: /(class="developer-credit">v)[\d.]+/, to: `$1${SHORT}` },
    { file: "README.md", find: /(\*\*Version )[\d.]+(\*\*)/, to: `$1${SHORT}$2` },
    { file: "README.md", find: /Lazy-Image-v[\d.]+-Windows\.zip/g, to: zipName },
  ];
  for (const edit of edits) {
    const path = join(root, edit.file);
    const before = readFileSync(path, "utf8");
    const after = before.replace(edit.find, edit.to);
    if (after !== before) {
      writeFileSync(path, after);
      log("[1/6]", `set ${VERSION} in ${edit.file}`);
    }
  }
}

/* Files that must never travel: debug ports, editor and OS litter. */
const SKIP = new Set([".debug", "node_modules", ".DS_Store", "__MACOSX", "Thumbs.db", ".git"]);

function count(dir) {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    n += entry.isDirectory() ? count(join(dir, entry.name)) : 1;
  }
  return n;
}

function stage() {
  syncVersion();
  rmSync(work, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  for (const dir of ["CSXS", "client", "host"]) {
    cpSync(join(root, dir), join(staging, dir), {
      recursive: true,
      filter: (src) => !SKIP.has(src.split(/[\\/]/).pop()),
    });
  }

  for (const needed of [
    "CSXS/manifest.xml", "client/index.html", "client/js/main.js",
    "client/js/browser-bridge.js", "host/index.jsx",
  ]) {
    if (!existsSync(join(staging, needed))) fail(`${needed} is missing from the panel.`);
  }
  /* Adobe's signature check replaces symlinks as it verifies, and needs rights
     the user may not have — which shows up as a blank panel. Allow none. */
  const links = [];
  (function scan(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) links.push(path);
      else if (entry.isDirectory()) scan(path);
    }
  })(staging);
  if (links.length) {
    fail(`the panel contains symlinks, which break signed installs:\n    ${links.join("\n    ")}`);
  }

  log("[2/6]", `staged ${count(staging)} panel files`);
}

function sign(tool) {
  if (!existsSync(p12)) {
    fail("no certificate yet. Run `node tools/package-zxp.mjs --cert` first.");
  }
  const pw = password();
  rmSync(zxp, { force: true });

  let signed = false;
  for (const tsa of TIMESTAMP_SERVERS) {
    try {
      run(tool, ["-sign", staging, zxp, p12, pw, "-tsa", tsa]);
      log("[3/6]", `signed, timestamped by ${tsa}`);
      signed = true;
      break;
    } catch {
      rmSync(zxp, { force: true });
      log("[3/6]", `${tsa} did not answer; trying the next timestamp server...`);
    }
  }
  if (!signed) {
    /* Without a timestamp the panel stops loading the day the certificate
       expires, so this is a fallback and it says so. */
    try {
      run(tool, ["-sign", staging, zxp, p12, pw]);
    } catch (error) {
      fail(`signing failed:\n${error.stdout || ""}${error.stderr || error.message}`);
    }
    log("[3/6]", "signed WITHOUT a timestamp — no timestamp server answered.");
    console.log("       Re-run with a connection: an untimestamped panel stops");
    console.log("       loading on the day the certificate expires.\n");
  }
  if (!existsSync(zxp)) fail("ZXPSignCmd reported success but no .zxp appeared.");
}

function verify(tool) {
  try {
    const out = run(tool, ["-verify", zxp, "-certInfo"]);
    log("[4/6]", "verified:");
    for (const line of out.trim().split(/\r?\n/)) console.log(`        ${line}`);
  } catch (error) {
    fail(`the signed package does not verify:\n${error.stdout || error.message}`);
  }
}

/* ------------------------------------------------------- what a user gets */

function assemble() {
  rmSync(payload, { recursive: true, force: true });
  mkdirSync(payload, { recursive: true });
  cpSync(zxp, join(payload, zxpName));

  /* cmd.exe misreads a .bat with Unix line endings, so installers and the
     guide are rewritten with Windows ones rather than copied as they are. */
  for (const name of readdirSync(join(root, "tools", "installer"))) {
    const from = join(root, "tools", "installer", name);
    const to = join(payload, name);
    if (/\.(bat|cmd|txt)$/i.test(name)) {
      writeFileSync(to, readFileSync(from, "utf8").replace(/\r?\n/g, "\r\n"));
    } else {
      cpSync(from, to);
    }
  }
  log("[5/6]", `assembled the download folder (${count(payload)} files)`);
}

function zip() {
  mkdirSync(downloads, { recursive: true });
  // One Lazy-Image zip there at a time; older versions stay on GitHub's releases page.
  // Anything else in the folder (LazyLord's zip, for one) is left alone.
  for (const old of readdirSync(downloads)) {
    if (/^Lazy-Image-v[\d.]+-Windows\.zip$/.test(old)) rmSync(join(downloads, old), { force: true });
  }
  const out = join(downloads, zipName);
  /* Built here rather than with Compress-Archive, which writes nested paths
     with backslashes — see tools/zip.mjs. */
  const bytes = writeZip(out, walk(payload, "Lazy-Image/"));
  log("[6/6]", `${out} (${(bytes / 1024).toFixed(1)} KB)`);
  return out;
}

/* ------------------------------------------------------------------- main */

const tool = signTool();

if (has("--cert")) {
  makeCert(tool);
  process.exit(0);
}

stage();
sign(tool);
verify(tool);
assemble();
const out = zip();
/* Leave one file behind, not a folder of half-built pieces. */
rmSync(work, { recursive: true, force: true });

console.log(`
Done. One file to give people:

  ${out}

They unzip it and double-click "install.bat".
Nothing else is needed — no extension manager, no debug mode.
`);
