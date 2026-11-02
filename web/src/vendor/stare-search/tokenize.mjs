// The search tokenizer, a port of src/stare_search/tok.py. Both must give the same tokens
// for the same text (tests/tokenizer_vectors.json); a query whose tokens differ from the
// build's finds nothing.

export const TOKENIZER_VERSION = 1;

export const STOPWORDS = new Set(
  'a an and are as at be but by for if in into is it of on or such that the their then there these they this to was will with'.split(
    ' '
  )
);

const DOTTED = /\b(?:[a-z]\.){2,}[a-z0-9]*/g;
const POSSESSIVE = /'s\b/g;
const THOUSANDS = /(?<=\d),(?=\d{3})/g;
const SPLIT = /[^a-z0-9]+/;

function keep(token) {
  const n = token.length;
  if (n < 2 || STOPWORDS.has(token)) return false;
  if (/^[a-z]+$/.test(token)) return n <= 25;
  if (/^[0-9]+$/.test(token)) return n <= 6;
  return n <= 12;
}

/** Text folded to the lowercase ASCII tokens are cut from. */
export function normalize(text) {
  let s = String(text).normalize('NFKD').replace(/[^\x00-\x7f]/g, '').toLowerCase();
  s = s.replace(DOTTED, (m) => m.replaceAll('.', ''));
  return s.replace(POSSESSIVE, '').replace(THOUSANDS, '');
}

/** The text's tokens, in order, repeats kept. */
export function tokens(text) {
  return normalize(text).split(SPLIT).filter(keep);
}
