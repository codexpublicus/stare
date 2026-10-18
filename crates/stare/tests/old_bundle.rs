//! With a data bundle older than citare v0.6.0, which has no edition slugs,
//! citations are looked up by CAP's `harvard_slug`. One test in its own binary:
//! the bundle can be swapped only before anything has used the data.

/// `bundle` without section `id` (citare's `docs/data-bundle.md`: a 12-byte
/// header, a varint section count, then `{ id, length, payload }` sections).
fn without_section(bundle: &[u8], id: u64) -> Vec<u8> {
    fn varint(b: &[u8], at: &mut usize) -> u64 {
        let (mut v, mut shift) = (0u64, 0);
        loop {
            let byte = b[*at];
            *at += 1;
            v |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return v;
            }
            shift += 7;
        }
    }
    fn put(out: &mut Vec<u8>, mut v: u64) {
        loop {
            let byte = (v & 0x7f) as u8;
            v >>= 7;
            if v == 0 {
                out.push(byte);
                return;
            }
            out.push(byte | 0x80);
        }
    }
    let mut at = 12;
    let count = varint(bundle, &mut at);
    let mut kept = Vec::new();
    for _ in 0..count {
        let sid = varint(bundle, &mut at);
        let len = varint(bundle, &mut at) as usize;
        if sid != id {
            kept.push((sid, &bundle[at..at + len]));
        }
        at += len;
    }
    assert_eq!(at, bundle.len());
    assert_eq!(kept.len() as u64, count - 1, "the bundle has section {id}");
    let mut out = bundle[..12].to_vec();
    put(&mut out, kept.len() as u64);
    for (sid, payload) in kept {
        put(&mut out, sid);
        put(&mut out, payload.len() as u64);
        out.extend_from_slice(payload);
    }
    out
}

#[test]
fn an_old_bundle_falls_back_to_harvard_slug() {
    // Section 11 is the edition slugs.
    let old = without_section(stare::data::embedded(), 11);
    stare::data::load(&old).expect("the stripped bundle loads");

    let cites = stare::cite::detect_citations("31 A.2d 647; 2021 NY Slip Op 01234");
    let a2d = cites
        .iter()
        .find(|c| c.matched_text.contains("A.2d"))
        .unwrap();
    assert_eq!(a2d.slug.as_deref(), Some("a2d"));
    // CAP never had NY Slip Op, so an old bundle can't reach it.
    let slip = cites
        .iter()
        .find(|c| c.matched_text.contains("Slip"))
        .unwrap();
    assert_eq!(slip.slug, None);
    let resolvable = stare::cite::resolvable_citations(&cites);
    assert_eq!(resolvable.len(), 1);
    assert_eq!(resolvable[0].slug.as_deref(), Some("a2d"));
}
