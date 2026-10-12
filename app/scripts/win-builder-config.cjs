// electron-builder config for the Windows installer: package.json's "build", except which node-pty prebuilds ship.
// package.json leaves out every win32 prebuild (macOS and Linux must not carry them, and electron-builder copies
// node_modules with exclusion patterns only, so a platform's "files" cannot add them back). Here win32-x64 stays
// (pty.node, conpty.node, conpty/conpty.dll, OpenConsole.exe, winpty) and the macOS and arm64 ones go.
// npm run dist:win → electron-builder --win --config scripts/win-builder-config.cjs
const { build } = require('../package.json');

const NO_WIN32 = '!node_modules/node-pty/prebuilds/win32-*/**';
const WIN_ONLY = [
  '!node_modules/node-pty/prebuilds/darwin-*/**',
  '!node_modules/node-pty/prebuilds/win32-arm64/**',
  '!node_modules/node-pty/prebuilds/win32-x64/*.pdb',
];

if (!build.files.includes(NO_WIN32)) throw new Error(`package.json build.files no longer has ${NO_WIN32}`);
// only config keys here: electron-builder rejects anything else
module.exports = { ...build, files: [...build.files.filter((f) => f !== NO_WIN32), ...WIN_ONLY] };
