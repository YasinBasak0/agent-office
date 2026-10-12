// electron-builder config for the Linux packages: package.json's "build" with node-pty's macOS prebuilds left out
// (on Linux node-pty is compiled from source). This used to be `linux.files` in package.json, but a platform
// "files" list with only exclusions makes electron-builder copy the whole app folder (CONTRACT.md, test/,
// scripts/, tsconfig.json ended up in the 0.6.3 .deb); the top-level list here keeps the package to what it names.
// npm run dist:linux → electron-builder --linux --config scripts/linux-builder-config.cjs
const { build } = require('../package.json');

// only config keys here: electron-builder rejects anything else
module.exports = { ...build, files: [...build.files, '!node_modules/node-pty/prebuilds/darwin-*/**'] };
