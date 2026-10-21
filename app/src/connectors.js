// Connectors (contract v3.42): a remote MCP server (address + token) the user works with in its own Claude Code session.
// A connector is a project (src/projects.js) with an `mcp: { label, url }` field, so it gets the boss, tabs, accounts,
// sleep, resume and the office like any project. Pure helpers (no Electron); main.js keeps the token (safeStorage).
const path = require('path');

/** A folder-safe name: 'My Notion!' → 'my-notion'. */
const slug = (s) => String(s || '').normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).toLowerCase() || 'connector';

/** The address when it is a usable http(s) URL, else ''. */
function cleanUrl(v) {
  try {
    const u = new URL(String(v || '').trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : '';
  } catch { return ''; }
}

/** state.json field: { label, url } or nothing (→ {}). */
function withMcp(v) {
  const url = cleanUrl(v?.url);
  const label = typeof v?.label === 'string' ? v.label.trim().slice(0, 60) : '';
  return url && label ? { mcp: { label, url } } : {};
}

/** Error code for a form ('name' | 'url') or null when it can be saved. */
function validate({ label, url }) {
  if (!String(label || '').trim()) return 'name';
  if (!cleanUrl(url)) return 'url';
  return null;
}

/** The server's name inside the session (`/mcp` lists it by this). */
const serverName = (label) => `conn-${slug(label)}`;

/** The claude MCP entry: remote HTTP server, the token as a bearer header. Lives only in the tab's 0600 MCP file. */
function serverConfig(url, token) {
  return { type: 'http', url: cleanUrl(url), ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}) };
}

/** `{ name: config }` for a project's session, or null (not a connector, or no usable address). */
function serverFor(project, token) {
  const m = withMcp(project?.mcp).mcp;
  return m ? { [serverName(m.label)]: serverConfig(m.url, token) } : null;
}

/**
 * The default folder for a connector: <root>/<slug>, or <slug>-2, -3… when another project already uses it. An existing
 * folder nobody uses is taken again (a connector added again finds its old session history).
 * @param {string} root @param {string} label @param {(dir: string) => boolean} taken another project has this folder
 */
function defaultDir(root, label, taken) {
  const base = slug(label);
  for (let i = 1; i < 100; i++) {
    const dir = path.join(root, i === 1 ? base : `${base}-${i}`);
    if (!taken(dir)) return dir;
  }
  return path.join(root, `${base}-${Date.now()}`);
}

const META_FILE = '.agent-office-mcp.json';
/** The connector's settings kept in its folder (never the token). */
const metaOf = ({ label, url }) => JSON.stringify({ label, url, server: serverName(label) }, null, 2) + '\n';

module.exports = { slug, cleanUrl, withMcp, validate, serverName, serverConfig, serverFor, defaultDir, META_FILE, metaOf };
