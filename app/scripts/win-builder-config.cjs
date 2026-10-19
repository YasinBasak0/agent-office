// electron-builder config for the Windows installer: package.json's "build", except which node-pty prebuilds ship.
// package.json leaves out every win32 prebuild (macOS and Linux must not carry them, and electron-builder copies
// node_modules with exclusion patterns only, so a platform's "files" cannot add them back). Here win32-x64 stays
// (pty.node, conpty.node, conpty/conpty.dll, OpenConsole.exe, winpty) and the macOS and arm64 ones go.
// npm run dist:win → electron-builder --win --config scripts/win-builder-config.cjs
const { build } = require('../package.json');

const NO_WIN32 = '!node_modules/node-pty/prebuilds/win32-*/**';
// udx-native and sodium-native (the device link): package.json ships only their darwin prebuilds; here win32-x64 only
const LINK_MAC = '!node_modules/{udx-native,sodium-native}/prebuilds/{android,ios,linux,win32}-*/**';
const LINK_WIN = '!node_modules/{udx-native,sodium-native}/prebuilds/{android,ios,linux,darwin,win32-arm64}*/**';
const WIN_ONLY = [
  '!node_modules/node-pty/prebuilds/darwin-*/**',
  '!node_modules/node-pty/prebuilds/win32-arm64/**',
  '!node_modules/node-pty/prebuilds/win32-x64/*.pdb',
];

for (const p of [NO_WIN32, LINK_MAC]) if (!build.files.includes(p)) throw new Error(`package.json build.files no longer has ${p}`);
// only config keys here: electron-builder rejects anything else
module.exports = { ...build, files: [...build.files.filter((f) => f !== NO_WIN32 && f !== LINK_MAC), ...WIN_ONLY, LINK_WIN] };
