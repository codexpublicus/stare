// Build identity for the footer. CI sets these at build time:
//   PUBLIC_RELEASE    the release tag (v2026.09.30.1) on a release build; main-<sha>,
//                     pr-<n> or unset on previews and local builds
//   PUBLIC_COMMIT     the full commit SHA (kept in a data attribute, never shown)
//   PUBLIC_BUILD_DATE the commit date, YYYY-MM-DD

export const WHATS_NEW_HREF = '/about#whats-new';

const RELEASE_TAG = /^v\d{4}\.\d{2}\.\d{2}\.\d+$/;
const SHA = /^[0-9a-f]{7,40}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Returns { release, label, href, date, commit }. A release build has its CalVer
// tag as the label and links to the changelog; anything else is a preview, which
// shows no tag and no link. Values that don't look like what CI sets are dropped.
export function buildInfo({ release, commit, date } = {}) {
  const rel = clean(release);
  const sha = clean(commit).toLowerCase();
  const day = clean(date);
  const info = {
    release: false,
    label: 'preview',
    href: null,
    date: DATE.test(day) ? day : null,
    commit: SHA.test(sha) ? sha : null,
  };
  if (RELEASE_TAG.test(rel)) {
    info.release = true;
    info.label = rel;
    info.href = WHATS_NEW_HREF;
  }
  return info;
}

// The visible text as one line: "v2026.10.01.1" on a release, "preview · 2026-10-01" otherwise.
export function buildLine(info) {
  return info.release ? info.label : [info.label, info.date].filter(Boolean).join(' · ');
}
