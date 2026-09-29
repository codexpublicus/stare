# Test fixtures

Everything here comes from one volume of the Caselaw Access Project: **a2d/152** (West's
Atlantic Reporter, Second Series, volume 152, 1959; Harvard barcode `32044109578831`). CAP
released this data as CC0, and it carries no copyright restrictions.

I fetched the members read-only, by byte range, from the static.case.law mirror on ml-01
(Docker volume `mirror_mirror-data`, file `downloads/a2d/152.tar`), for example:

```sh
ssh ml-01 'docker run --rm -v mirror_mirror-data:/data:ro rclone/rclone:latest \
  cat --offset 26136576 --count 39806 /data/downloads/a2d/152.tar'
```

The offsets and sizes come from the volume's `152.tar.csv`. Every page and case member
matches the MD5 the volume METS records for it.

## `a2d-152/152.tar` and `a2d-152/152.tar.csv`

A small tar slice of the volume, built by `scripts/make_fixture.py`, with a `.tar.csv` in the
mirror's format (`path,offset,size`, CRLF line endings, `offset` is where the member's data
starts). It holds four consecutive pages and the three cases that touch them:

| METS ORDER | Page label | Case | ALTO words |
|---|---|---|---|
| 870 | 838 | last page of case 201 (duplicative) | 0 |
| 871 | 839 | Bondy v. Pappas, 152 A.2d 839 (case 202) | 302 |
| 872 | 840 | Bondy v. Pappas | 251 |
| 873 | 841 | first page of case 203 (duplicative) | 0 |

For each page the tar has the bitonal TIFF and the gzipped ALTO, byte for byte as in the
volume tar; the color JPGs are left out to keep the fixture small, though the METS still
lists them. The three CASEMETS files are unmodified. Cases 201 and 203 run past the slice
(pages 833 to 838 and 841 to 847), and their CASEMETS say so.

The volume METS is the one member that isn't byte for byte: `make_fixture.py` trims it to
the four pages and three cases above (and the `fileSec` entries they reference) and
re-gzips it with a fixed timestamp. The volume's `METS.md5` is left out because it no longer
matches, and the volume has a BOXES file that the slice doesn't include.

Rebuilding the tar from the same members gives the same bytes.

## `a2d-152/source/`

Two files kept exactly as the mirror has them, for tests that need the whole volume:

- `152.tar.csv`: the manifest for the full 69 MB tar (3,400 members, CRLF).
- `32044109578831_redacted_METS.xml.gz`: the untrimmed volume METS (1,056 pages, 225
  cases, 218 of them duplicative).

The scans are redacted by design: headnotes, syllabi and duplicative cases are blacked out,
which is why pages 870 and 873 have no ALTO words.
