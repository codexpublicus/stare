# Mirror

`docker-compose.yaml`, `aria2.conf`, `init-input.sh` and the `urls*.txt` lists are the aria2 job
that downloaded static.case.law; `docs/plans/static-case-law-mirror.md` has its history.

## Auditing the tars

`tar_audit.py` hashes every `<reporter>/<volume>.tar` on the mirror and compares it to the
published `<volume>.tar.sha256` (a bare 64-character hex digest, no newline) (#77). It's stdlib
Python, so it runs in the read-only `cap-mirror-run` container on ml-01. Copy it into a scratch
dir first, since that dir is the container's `/work`:

```bash
scratch=~/.claude/jobs/<job>/tmp      # or any dir you own under /tmp
cp mirror/tar_audit.py "$scratch"/
cap-mirror-run "$scratch" python -u /work/tar_audit.py audit --jobs 3 >> "$scratch"/audit.log 2>&1
```

Each file gets one line in `/work/tar-audit.jsonl` with its path, size, mtime, expected and
actual digest, status (`ok`, `mismatch`, `missing_tar`, `missing_sha`, `bad_sha`, `unreadable`)
and seconds. The run is resumable: rerunning the same command skips every path already in the
JSONL except `unreadable` ones, which are retried. `--path a2d/142.tar` or `--reporter a2d`
limits it; keep `--jobs` at 4 or below so the NAS stays responsive. At three jobs the full
mirror (about 10 TB) takes roughly 7 hours.

Then, for the files that aren't `ok`:

```bash
cap-mirror-run "$scratch" python /work/tar_audit.py summary          # counts and the non-ok list
cap-mirror-run "$scratch" python /work/tar_audit.py inspect          # zip testzip(), tar.csv vs tar size
python mirror/tar_audit.py head --out "$scratch"/tar-audit.jsonl     # on the host: HEAD on static.case.law
```

`inspect` checks the volume's `.zip` with `zipfile.testzip()` and works out the tar length its
`.tar.csv` implies (end of the last member, rounded to 512 bytes, plus the two end blocks).
`head` sends one HEAD request per non-ok tar, half a second apart, and compares
`Content-Length` with the local size; it never downloads anything.
