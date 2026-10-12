// The sidebar's per-project subline (pure: the renderer draws it, tests run it with a translator).

/**
 * "2 working · 5 delivered", or "idle". Work across projects (contract v3.5): agents of another project's session
 * working in this project's folder (readOffice's `remote`) count toward its "N working", and the line names where
 * they are worked on from.
 * @param {{ working?: number, delivered?: number, remote?: { working?: number, from?: string[] } | null } | undefined} s
 *   one entry of OfficeData.projects
 * @param {(key: string, vars?: Record<string, unknown>) => string} t the translator
 */
export function projectStatus(s, t) {
  if (!s) return t('sidebar.idle');
  const parts = [];
  const working = (s.working || 0) + (s.remote?.working || 0);
  if (working) parts.push(t('sidebar.working', { n: working }));
  if (s.delivered) parts.push(t('sidebar.delivered', { n: s.delivered }));
  const from = Array.isArray(s.remote?.from) ? s.remote.from.filter(Boolean) : [];
  if (from.length) parts.push(t('sidebar.workedFrom', { from: from.join(', ') }));
  return parts.length ? parts.join(' · ') : t('sidebar.idle');
}

/** The boss's star on the project row: the boss works on this project, from its own session or from another one. */
export const isBossHere = (s) => Boolean(s?.isBossBusy || s?.remote?.isBossBusy);
