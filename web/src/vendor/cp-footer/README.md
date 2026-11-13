# The Codex Publicus footer, vendored

`footer.html` and `footer.css` are byte-for-byte copies of `footer/footer.html` and
`public/footer.css` in codexpublicus/codexpublicus.org at commit
`9b2274c14d2ab4b69608dd88ad7196a9e2cef75d` (2026-11-13, codexpublicus/codexpublicus.org#14;
the repo has no tags yet). Don't edit
them here: change the canonical copy and copy it in again.

`web/src/components/SiteFooter.astro` carries the fragment with stare.pub's two slots
filled, and `web/tests/footer.test.js` fails if its markup differs from `footer.html`
outside the slots. `layout.css` imports `footer.css` and then points the footer's colour
tokens at stare.pub's theme, because stare.pub's theme switch removes `data-theme` for
light rather than setting `data-theme="light"`, which `footer.css` alone would read as
"follow the system".

The GitHub, X and Hugging Face icons are Simple Icons 16.35.0 path data (CC0 1.0); see
the canonical repo's `footer/README.md`.
