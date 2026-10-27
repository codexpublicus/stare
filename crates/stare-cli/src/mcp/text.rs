//! A case's text sized for a model's context (design, "Response sizing"): the opinions
//! joined as `stare resolve` prints them, windows of it that end at a paragraph, and
//! `find`, which matches a quotation with case, whitespace, curly quotes and dashes
//! folded, and reports a near match with its edit distance when there is no exact one.
//! Every offset is in characters (code points).

/// A case's text: its opinions, each with a header line, and where each starts.
pub struct CaseText {
    pub text: String,
    /// The byte offset of each character, and the text's length at the end.
    bytes: Vec<usize>,
    /// For each opinion included: its index in the case, and its character range.
    pub opinions: Vec<(usize, usize, usize)>,
}

impl CaseText {
    /// The opinions of `case`, or only `only`, as `[majority — Author]`, a blank line,
    /// the text and a blank line.
    pub fn new(case: &stare::case::CaseJson, only: Option<usize>) -> CaseText {
        let mut text = String::new();
        let mut ranges = Vec::new();
        for (i, o) in case.casebody.opinions.iter().enumerate() {
            if only.is_some_and(|n| n != i) {
                continue;
            }
            let start = text.chars().count();
            match &o.author {
                Some(author) => text.push_str(&format!("[{} — {}]\n\n", o.opinion_type, author)),
                None => text.push_str(&format!("[{}]\n\n", o.opinion_type)),
            }
            text.push_str(&o.text);
            text.push_str("\n\n");
            ranges.push((i, start, text.chars().count()));
        }
        let mut bytes: Vec<usize> = text.char_indices().map(|(b, _)| b).collect();
        bytes.push(text.len());
        CaseText {
            text,
            bytes,
            opinions: ranges,
        }
    }

    /// Its length in characters.
    pub fn len(&self) -> usize {
        self.bytes.len() - 1
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Characters `start..end`.
    pub fn slice(&self, start: usize, end: usize) -> &str {
        let (start, end) = (start.min(self.len()), end.min(self.len()));
        &self.text[self.bytes[start]..self.bytes[end.max(start)]]
    }

    /// The opinion (its index in the case) that character `at` is in.
    pub fn opinion_at(&self, at: usize) -> Option<usize> {
        self.opinions
            .iter()
            .find(|(_, s, e)| (*s..*e).contains(&at))
            .map(|(i, ..)| *i)
    }

    /// Where a window of at most `max` characters from `start` ends: at a paragraph end
    /// when one is within the last tenth of it, else at `max`.
    pub fn window_end(&self, start: usize, max: usize) -> usize {
        let end = (start + max).min(self.len());
        if end == self.len() {
            return end;
        }
        let floor = end - max / 10;
        let window = self.slice(floor, end);
        match window.rfind('\n') {
            Some(b) => floor + window[..b].chars().count() + 1,
            None => end,
        }
    }
}

/// One place `find` matched.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Match {
    pub start: usize,
    pub end: usize,
    /// 0 for an exact match (after folding), else the edit distance of a near one.
    pub distance: usize,
}

/// A text folded for matching, with each folded character's place in the original.
struct Folded {
    chars: Vec<char>,
    at: Vec<usize>,
}

fn fold(text: &str) -> Folded {
    let mut chars = Vec::new();
    let mut at = Vec::new();
    let mut space = false;
    for (i, c) in text.chars().enumerate() {
        if c.is_whitespace() {
            if !space && !chars.is_empty() {
                chars.push(' ');
                at.push(i);
            }
            space = true;
            continue;
        }
        space = false;
        let c = match c {
            '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' | '\u{2032}' | '`' => '\'',
            '\u{201C}' | '\u{201D}' | '\u{201E}' | '\u{201F}' | '\u{2033}' => '"',
            '\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2015}' => '-',
            '\u{00AD}' => continue,
            c => c,
        };
        for l in c.to_lowercase() {
            chars.push(l);
            at.push(i);
        }
    }
    if chars.last() == Some(&' ') {
        chars.pop();
        at.pop();
    }
    Folded { chars, at }
}

/// The longest quotation a near match is looked for: the search is quadratic.
pub const NEAR_MAX: usize = 500;

/// Where `query` is in `text`, folded: every exact match, at most `limit`; with none,
/// the nearest match within an edit distance of a fifth of the query's length, if any.
pub fn find(text: &str, query: &str, limit: usize) -> Vec<Match> {
    let t = fold(text);
    let q = fold(query);
    if q.chars.is_empty() || t.chars.is_empty() {
        return Vec::new();
    }
    let end_of = |i: usize| t.at[i] + 1;
    let mut out = Vec::new();
    let m = q.chars.len();
    let mut i = 0;
    while i + m <= t.chars.len() && out.len() < limit {
        if t.chars[i..i + m] == q.chars[..] {
            out.push(Match {
                start: t.at[i],
                end: end_of(i + m - 1),
                distance: 0,
            });
            i += m;
        } else {
            i += 1;
        }
    }
    if !out.is_empty() || m > NEAR_MAX {
        return out;
    }
    // Sellers' algorithm: edit distance of the query against any substring of the
    // text, carrying where each alignment starts.
    let max = (m / 5).max(1);
    let mut d: Vec<usize> = (0..=m).collect();
    let mut s: Vec<usize> = vec![0; m + 1];
    let mut best: Option<(usize, usize, usize)> = None;
    for (j, &tc) in t.chars.iter().enumerate() {
        let (mut diag, mut diag_s) = (d[0], s[0]);
        d[0] = 0;
        s[0] = j + 1;
        for i in 1..=m {
            let (up, up_s) = (d[i], s[i]);
            let sub = diag + usize::from(q.chars[i - 1] != tc);
            let (mut v, mut vs) = (sub, diag_s);
            if up + 1 < v {
                (v, vs) = (up + 1, up_s);
            }
            if d[i - 1] + 1 < v {
                (v, vs) = (d[i - 1] + 1, s[i - 1]);
            }
            diag = up;
            diag_s = up_s;
            d[i] = v;
            s[i] = vs;
        }
        if d[m] <= max && best.is_none_or(|(b, ..)| d[m] < b) {
            best = Some((d[m], s[m], j));
        }
    }
    best.into_iter()
        .filter(|&(_, start, end)| start <= end)
        .map(|(distance, start, end)| Match {
            start: t.at[start],
            end: end_of(end),
            distance,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_folds_case_space_and_quotes() {
        let text = "A man\u{2019}s residence is where he\n actually dwells, and ordinarily...";
        let m = find(text, "a man's RESIDENCE is where he actually dwells", 10);
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].distance, 0);
        let chars: Vec<char> = text.chars().collect();
        let got: String = chars[m[0].start..m[0].end].iter().collect();
        assert_eq!(
            got,
            "A man\u{2019}s residence is where he\n actually dwells"
        );
    }

    #[test]
    fn find_reports_a_near_match_with_its_distance() {
        let text = "Residence is the test, and the fact that defendant had an established office is not material.";
        let m = find(
            text,
            "the fact that the defendant had an established office",
            10,
        );
        assert_eq!(m.len(), 1);
        assert!(m[0].distance > 0 && m[0].distance <= 4, "{m:?}");
        let chars: Vec<char> = text.chars().collect();
        let got: String = chars[m[0].start..m[0].end].iter().collect();
        assert!(got.contains("defendant had an established office"), "{got}");
        assert!(find(text, "something else entirely, not in the text at all", 10).is_empty());
    }

    #[test]
    fn find_stops_at_the_limit() {
        let text = "id. ".repeat(20);
        assert_eq!(find(&text, "Id.", 10).len(), 10);
    }
}
