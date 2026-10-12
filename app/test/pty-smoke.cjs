// Packaged-app smoke test for CI's Windows job: the installer's node-pty (from app.asar.unpacked, as main.js loads
// it on Windows) runs a command in a ConPTY under the app's own Electron, and its output comes back.
// ELECTRON_RUN_AS_NODE=1 "release/win-unpacked/Agent Office.exe" test/pty-smoke.cjs <path to unpacked node-pty>
const pty = require(process.argv[2]);
const marker = 'agent-office-pty-ok';
let out = '';
const t = pty.spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', `echo ${marker}`], { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env });
const timer = setTimeout(() => { console.error('timed out; output so far:', JSON.stringify(out)); process.exit(1); }, 30000);
t.onData((d) => { out += d; });
t.onExit(({ exitCode }) => {
  clearTimeout(timer);
  // ConPTY may deliver the last output just after the exit event
  setTimeout(() => {
    const ok = out.includes(marker);
    console.log(ok ? `ok: ${marker} (exit ${exitCode})` : `missing output (exit ${exitCode}): ${JSON.stringify(out)}`);
    process.exit(ok ? 0 : 1);
  }, 500);
});
