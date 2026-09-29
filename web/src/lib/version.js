// Build identity for the footer. CI sets these at build time:
//   PUBLIC_RELEASE  the release tag (v2026.09.30.1), main-<sha> on main previews,
//                   pr-<n> on PR previews; unset for local builds, which show "dev"
//   PUBLIC_COMMIT   the full commit SHA
//   PUBLIC_BUILD_DATE the commit date, YYYY-MM-DD

export const REPO_URL = 'https://github.com/codexpublicus/stare';

const RELEASE_TAG = /^v\d{4}\.\d{2}\.\d{2}\.\d+$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA = /^[0-9a-f]{7,40}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Returns { label, labelHref, sha, shaHref, date }; any of the last four may be
// null. Values that don't look like what CI sets are dropped, not shown raw.
export function buildInfo({ release, commit, date } = {}) {
  const rel = clean(release);
  const fullSha = clean(commit).toLowerCase();
  const day = clean(date);

  const sha = SHA.test(fullSha) ? fullSha.slice(0, 7) : null;
  const shaHref = sha ? `${REPO_URL}/commit/${fullSha}` : null;
  const info = { label: 'dev', labelHref: null, sha, shaHref, date: DATE.test(day) ? day : null };

  if (!LABEL.test(rel)) return info;
  info.label = rel;
  if (RELEASE_TAG.test(rel)) {
    info.labelHref = `${REPO_URL}/releases/tag/${rel}`;
  } else if (sha && rel.endsWith(sha)) {
    // main-<sha>: the label already names the commit, so link it and don't
    // repeat the SHA.
    info.labelHref = shaHref;
    info.sha = null;
    info.shaHref = null;
  }
  return info;
}

// The same fields as one line of text, e.g. "v2026.09.30.1 · 7c42187 · 2026-09-30".
export function buildLine(info) {
  return [info.label, info.sha, info.date].filter(Boolean).join(' · ');
}
