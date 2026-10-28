//! Naming a case to an agent: its `case_ref`, which names one case in a build and which
//! `get_case` reads back, and its `reader_url`, the stare.pub address for a person.

use super::error::{Code, ToolError, ToolResult};
use stare::parallel::CaseRef;

/// `cap:<slug>/<folder>/<file>` (`cap:a2d/31/0647-01`) or `cl:<cluster>/<hash>`
/// (`cl:4893133/62f253f296600fb7`).
pub fn case_ref(r: &CaseRef) -> String {
    match r {
        CaseRef::Cap {
            reporter,
            folder,
            case_file,
        } => format!("cap:{reporter}/{folder}/{case_file}"),
        CaseRef::Cl { cluster_id, hash } => format!("cl:{cluster_id}/{hash}"),
    }
}

/// A `case_ref` read back, checked with the validators the paths are built with.
pub fn parse_case_ref(s: &str) -> ToolResult<CaseRef> {
    let bad = || {
        ToolError::new(
            Code::BadRef,
            format!(
                "not a case_ref: {s:?}; use one from a result, like cap:a2d/31/0647-01 or cl:4893133/62f253f296600fb7"
            ),
        )
    };
    if let Some(rest) = s.strip_prefix("cap:") {
        let mut parts = rest.splitn(3, '/');
        let (Some(reporter), Some(folder), Some(case_file)) =
            (parts.next(), parts.next(), parts.next())
        else {
            return Err(bad());
        };
        let file_ok = !case_file.is_empty()
            && !case_file.contains('/')
            && case_file != "."
            && case_file != ".."
            && !case_file.chars().any(char::is_control);
        if !stare::cl::is_reporter_slug(reporter)
            || !stare::manifest::is_volume_key(folder)
            || !file_ok
        {
            return Err(bad());
        }
        return Ok(CaseRef::Cap {
            reporter: reporter.into(),
            folder: folder.into(),
            case_file: case_file.into(),
        });
    }
    if let Some(rest) = s.strip_prefix("cl:") {
        let (cluster, hash) = rest.split_once('/').ok_or_else(bad)?;
        let cluster_id: u64 = cluster.parse().map_err(|_| bad())?;
        if !stare::cl::is_hash(hash) || cluster.starts_with('+') {
            return Err(bad());
        }
        return Ok(CaseRef::Cl {
            cluster_id,
            hash: hash.into(),
        });
    }
    Err(bad())
}

/// The stare.pub address of a case named as [`stare::parallel`] names cases
/// (`a2d/31/657-2`, the second case at 31 A.2d 657): `https://stare.pub/#a2d/31/657-02`,
/// as the site's `caseHash` writes it. None for a name that isn't one.
pub fn reader_url(id: &str) -> Option<String> {
    let mut parts = id.splitn(3, '/');
    let (slug, volume, rest) = (parts.next()?, parts.next()?, parts.next()?);
    let (page, seq) = match rest.rsplit_once('-') {
        Some((page, n))
            if !page.is_empty() && !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) =>
        {
            (page, n.parse::<u32>().ok()?)
        }
        _ => (rest, 1),
    };
    Some(format!(
        "https://stare.pub/#{slug}/{volume}/{}-{seq:02}",
        encode_uri_component(page)
    ))
}

/// JavaScript's `encodeURIComponent`.
fn encode_uri_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn case_refs_round_trip_and_refuse_paths() {
        for s in [
            "cap:a2d/31/0647-01",
            "cap:a3d/138-2/1012-01",
            "cl:4893133/62f253f296600fb7",
        ] {
            assert_eq!(case_ref(&parse_case_ref(s).unwrap()), s);
        }
        assert_eq!(
            case_ref(&parse_case_ref("cap:us/1/11, 12-01").unwrap()),
            "cap:us/1/11, 12-01"
        );
        for s in [
            "a2d/31/0647-01",
            "cap:a2d/31",
            "cap:a2d/../0647-01",
            "cap:A2D/31/0647-01",
            "cap:a2d/31/x/y",
            "cap:a2d/31/..",
            "cl:4893133/xyz",
            "cl:+1/62f253f296600fb7",
            "cl:abc/62f253f296600fb7",
        ] {
            assert_eq!(parse_case_ref(s).unwrap_err().code, Code::BadRef, "{s}");
        }
    }

    #[test]
    fn reader_urls_are_the_sites() {
        assert_eq!(
            reader_url("a2d/31/647").as_deref(),
            Some("https://stare.pub/#a2d/31/647-01")
        );
        assert_eq!(
            reader_url("a2d/31/657-2").as_deref(),
            Some("https://stare.pub/#a2d/31/657-02")
        );
        assert_eq!(
            reader_url("cal-app-4th/15/supp. 1").as_deref(),
            Some("https://stare.pub/#cal-app-4th/15/supp.%201-01")
        );
        assert_eq!(reader_url("a2d"), None);
    }
}
