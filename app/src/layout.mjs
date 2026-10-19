// Window chrome helpers (contract v3.18; pure: the renderer uses them, tests run them).

/**
 * A folder with the home folder written as `~`: '/Users/me/Projects/x' → '~/Projects/x'.
 * Only a whole leading path segment matches ('/Users/meow' stays as it is); Windows paths compare without case.
 * @param {string | null | undefined} dir
 * @param {string | null | undefined} home
 */
export function tildePath(dir, home) {
  const d = String(dir || '');
  const hm = String(home || '').replace(/[\\/]+$/, '');
  if (!d || !hm) return d;
  const win = /^[A-Za-z]:[\\/]/.test(hm) || hm.startsWith('\\\\');
  const same = win ? d.slice(0, hm.length).toLowerCase() === hm.toLowerCase() : d.startsWith(hm);
  if (!same) return d;
  const rest = d.slice(hm.length);
  if (rest === '') return '~';
  return /^[\\/]/.test(rest) ? '~' + rest : d;
}

/**
 * Native window title: 'name — ~/path — Agent Office', 'Agent Office' with no project.
 * @param {{ name?: string, dir?: string } | null | undefined} project
 * @param {string | null | undefined} home
 * @param {string} app
 */
export function windowTitle(project, home, app) {
  if (!project?.dir) return app;
  return `${project.name || ''} — ${tildePath(project.dir, home)} — ${app}`;
}

export const SPLIT_MIN_TOP = 150;   // PROJECTS: heading, about two rows, "+ Add project"
export const SPLIT_MIN_BOTTOM = 96; // ACCOUNTS: heading and about one account
export const SPLIT_DEFAULT = 0.38;  // ACCOUNTS share of the sidebar's height until the divider is dragged

/**
 * Height of the sidebar's lower part (ACCOUNTS and settings) for a wanted height, kept so both parts stay usable.
 * When the sidebar is too short for both minimums, the projects part wins.
 * @param {number} want wanted lower-part height in px
 * @param {number} total sidebar's inner height in px
 * @param {number} [divider] divider's height in px
 */
export function clampSplit(want, total, divider = 0) {
  const max = Math.max(0, total - divider - SPLIT_MIN_TOP);
  const h = Number.isFinite(want) ? want : total * SPLIT_DEFAULT;
  return Math.round(Math.max(Math.min(SPLIT_MIN_BOTTOM, max), Math.min(max, h)));
}
