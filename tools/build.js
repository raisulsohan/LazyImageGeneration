// Builds the release package: obfuscated code, a copying installer and the install
// guide. Nothing from tools/ or the rest of the repo ships.
//
//   node tools/build.js
//
// Output: D:\GitHub\For Sale\Lazy-Image
//
// Lazy-Image is free. There is no licence check, so the package is exactly the panel in
// this repo, with its JavaScript obfuscated.
const fs = require('fs');
const path = require('path');
const obfuscator = require('javascript-obfuscator');

const ROOT = path.join(__dirname, '..');
const OUT = path.join('D:', '\\GitHub', 'For Sale', 'Lazy-Image');

// Strong settings for files that only ever run inside the panel.
const FULL = {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.5,
    identifierNamesGenerator: 'hexadecimal',
    numbersToExpressions: true,
    simplify: true,
    splitStrings: true,
    splitStringsChunkLength: 10,
    stringArray: true,
    stringArrayThreshold: 0.85,
    stringArrayEncoding: ['base64'],
    stringArrayWrappersCount: 2,
    deadCodeInjection: false,
    selfDefending: false,
    transformObjectKeys: false,
    unicodeEscapeSequence: false
};

// browser-bridge.js sends some of its own functions into the ChatGPT page via
// Function#toString(). Anything that lifts strings or control flow into module scope would
// leave those copies referencing helpers that do not exist there, so this file only gets
// transforms that keep every function self-contained.
const SELF_CONTAINED = {
    compact: true,
    identifierNamesGenerator: 'hexadecimal',
    simplify: true,
    stringArray: false,
    controlFlowFlattening: false,
    deadCodeInjection: false,
    selfDefending: false,
    numbersToExpressions: false,
    unicodeEscapeSequence: false
};

const JS_FILES = [
    { from: 'client/js/CSInterface.js', options: FULL },
    { from: 'client/js/utils/storage.js', options: FULL },
    { from: 'client/js/browser-bridge.js', options: SELF_CONTAINED },
    { from: 'client/js/main.js', options: FULL }
];

const COPY_FILES = [
    { from: 'CSXS/manifest.xml', to: 'CSXS/manifest.xml' },
    { from: 'host/index.jsx', to: 'host/index.jsx' },
    { from: 'client/index.html', to: 'client/index.html' },
    { from: 'client/css/style.css', to: 'client/css/style.css' },
    { from: 'tools/installguide.txt', to: 'installguide.txt' },
    { from: 'tools/install-forsale.bat', to: 'install.bat' }
];

function write(relative, contents) {
    const target = path.join(OUT, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
    return target;
}

function kb(bytes) {
    return (bytes / 1024).toFixed(1) + ' KB';
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

console.log('Building to: ' + OUT + '\n');

let plain = 0;
let hidden = 0;
JS_FILES.forEach(file => {
    const source = fs.readFileSync(path.join(ROOT, file.from), 'utf8');
    const code = obfuscator.obfuscate(source, file.options).getObfuscatedCode();
    write(file.from, code);
    plain += source.length;
    hidden += code.length;
    console.log('  obfuscated  ' + file.from.padEnd(32) +
        kb(source.length).padStart(9) + '  ->  ' + kb(code.length).padStart(9) +
        (file.options === SELF_CONTAINED ? '   (page-safe profile)' : ''));
});

COPY_FILES.forEach(file => {
    write(file.to, fs.readFileSync(path.join(ROOT, file.from)));
    console.log('  copied      ' + file.to);
});

const manifest = fs.readFileSync(path.join(OUT, 'CSXS/manifest.xml'), 'utf8');
const version = (manifest.match(/ExtensionBundleVersion="([^"]+)"/) || [])[1] || '?';

console.log('\nVersion ' + version + '  ·  JavaScript ' + kb(plain) + ' -> ' + kb(hidden));
console.log('\nShipped:');
(function list(dir, indent) {
    fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).forEach(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            console.log(indent + entry.name + '/');
            list(full, indent + '   ');
        } else {
            console.log(indent + entry.name.padEnd(24) + kb(fs.statSync(full).size).padStart(9));
        }
    });
})(OUT, '  ');
console.log('\nZip the "Lazy-Image" folder to share it.');
