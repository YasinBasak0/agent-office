// Stand-in for `claude auth login` (Claude Code 2.1.304's strings) in the v3.34 login relay tests. Never a real login.
// STUB_HOST changes the URL's host (host rejection); STUB_HANG=1 never prints the code prompt's outcome (timeout).
'use strict';
const host = process.env.STUB_HOST || 'claude.ai';
const url = `https://${host}/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference&code_challenge=abc123def456&code_challenge_method=S256&state=xyzSTATE123`;
process.stdout.write('\x1b[?25l\x1b[2K\x1b[1G\x1b[1mOpening browser to sign in…\x1b[22m\r\n');
process.stdout.write("\x1b[2mBrowser didn't open? Use the url below to sign in\x1b[22m\r\n\r\n");
process.stdout.write(`\x1b]8;;${url}\x07${url}\x1b]8;;\x07\r\n\r\n`);
process.stdout.write('Paste code here if prompted > ');
if (process.env.STUB_HANG === '1') setInterval(() => {}, 1000);
let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString();
  if (!/[\r\n]/.test(buf)) return;
  const code = buf.trim();
  const ok = /^[A-Za-z0-9._~-]{10,400}#[A-Za-z0-9._~-]{8,200}$/.test(code);
  process.stdout.write(ok ? '\r\nLogin successful.\r\n' : '\r\nOAuth error: Invalid code\r\n');
  process.exit(ok ? 0 : 1);
});
