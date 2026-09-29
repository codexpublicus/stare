# Archival PDF run on ml-01 (codexpublicus/stare#51)

This builds one archival PDF per volume from the CAP tars, verifies every page against its
TIFF and ALTO, and uploads the PDFs and their manifests to `codex-data/cap-pdf/`. You run
every command below from your own machine; each is one line and goes to ml-01 over ssh.
Nothing here writes to the mirror: `codexpublicus-cap-mirror` is read-only at the NFS export
and the ZFS dataset, and every container mounts it `:ro` as well.

What's where on ml-01:

| Docker volume | Mounted at | Holds |
|---|---|---|
| `codexpublicus-cap-mirror` | `/mirror` (read-only) | the mirror, `downloads/<reporter>/<volume>.{tar,tar.csv,tar.sha256}` |
| `codexpublicus-derived` | `/out` | the output: `cap-pdf/<reporter>/<volume>.pdf`, `cap-pdf/_manifests/<reporter>/<volume>.json`, plus `failed/`, `runs/` |

Scratch files (jbig2's page files, pdfimages' chunks) go to `/tmp/archival-work` inside the
container, which is ml-01's local disk, not the share. The whole output is about 1.6 TB and
fits on `codexpublicus-derived`, so the default is to build everything there and upload it
afterwards, keeping the local copy. The streaming mode at the end is for a machine without
the share.

## 1. Build the image on ml-01

The image is built from `origin/main`, streamed to ml-01 as a tar, so ml-01 needs no clone
or GitHub credentials. It's tagged with the commit and as `stare-archival:current`.

```sh
git -C ~/projects/lokkju/codexpublicus/stare fetch origin
```

```sh
git -C ~/projects/lokkju/codexpublicus/stare archive origin/main:pipelines/archival-pdf | ssh ml-01 "DOCKER_BUILDKIT=1 docker build --build-arg REVISION=$(git -C ~/projects/lokkju/codexpublicus/stare rev-parse origin/main) -t stare-archival:$(git -C ~/projects/lokkju/codexpublicus/stare rev-parse --short=12 origin/main) -t stare-archival:current -"
```

```sh
ssh ml-01 'docker image inspect --format "{{.Id}} {{.Size}}" stare-archival:current && docker run --rm --entrypoint sh stare-archival:current -c "jbig2 --version; pdfimages -v 2>&1 | head -1; rclone version | head -1; stare-archival --version; echo \$STARE_ARCHIVAL_REVISION"'
```

Expect jbig2enc 0.28, pdfimages 24.02.0, rclone v1.75.1, stare-archival 0.1.0 and the
commit you built.

The run records the image id in every manifest (`pins.pipeline`) and the commit in its tools
(`stare-archival-revision`). A volume counts as done only for the same commit, so an image
built from a later commit rebuilds everything; rebuild the image only when you mean that.

## 2. Preflight

The mirror is readable (expect about 400 reporter directories):

```sh
ssh ml-01 'docker run --rm --entrypoint rclone -v codexpublicus-cap-mirror:/mirror:ro stare-archival:current lsf --dirs-only /mirror/downloads | wc -l'
```

The output share is writable by the image's user (uid 10001):

```sh
ssh ml-01 'docker run --rm --entrypoint sh -v codexpublicus-derived:/out stare-archival:current -c "id; stat -c \"%u:%g %A\" /out; touch /out/.write-probe && rm /out/.write-probe && echo writable"'
```

If that fails with "Permission denied", add `--user <uid>:<gid>` (the owner `stat` printed)
right after `--init` in every `docker run` below.

## 3. Pilot: 20 volumes

The pilot spans the 1780s to 2017, tars from 66 MiB to 483 MiB, and federal, state,
territorial and tribal reporters. All 20 have tars on the mirror (checked 2026-09-29):

| Volume | Why | Tar |
|---|---|---|
| `us/1` | first volume of the U.S. Reports (Dallas), 1790s | 151 MiB |
| `us/10` | early U.S. Reports; measured in A3 and A4 | 72 MiB |
| `kirby/1` | Kirby's Connecticut, 1780s | 102 MiB |
| `root/1` | Root's Connecticut, 1790s | 143 MiB |
| `mass/1` | 1800s | 120 MiB |
| `pa/1` | 1840s | 141 MiB |
| `haw/1` | Hawaii, 1840s and 1850s | 90 MiB |
| `ark/1` | 1830s | 171 MiB |
| `f-supp/1` | first F. Supp., 1932 | 389 MiB |
| `a2d/152` | 1959, many short pages; measured in A3 and A4 | 66 MiB |
| `f2d/500` | 1974, large | 462 MiB |
| `am-samoa/1` | territorial | 151 MiB |
| `navajo-rptr/1` | tribal | 183 MiB |
| `wash-2d/187` | 2010s | 85 MiB |
| `ga-app/342` | 2010s | 117 MiB |
| `ne2d/999` | 2010s | 210 MiB |
| `ill-app-3d/409` | 2010s | 326 MiB |
| `f3d/500` | 2007, 1,522 dense pages; the slowest measured | 483 MiB |
| `f-supp-2d/999` | 2010s, large | 482 MiB |
| `ny3d/29` | 2017, the newest | 195 MiB |

The pilot writes to `codexpublicus-derived` like the full run, so the full run skips these
20 if they pass.

```sh
ssh ml-01 'docker run -d --name archival-pilot --init -e STARE_ARCHIVAL_IMAGE="$(docker image inspect --format "{{.Id}}" stare-archival:current)" -v codexpublicus-cap-mirror:/mirror:ro -v codexpublicus-derived:/out stare-archival:current build-all --src /mirror/downloads --out /out --work /tmp/archival-work --jobs 20 --only us/1 --only us/10 --only kirby/1 --only root/1 --only mass/1 --only pa/1 --only haw/1 --only ark/1 --only f-supp/1 --only a2d/152 --only f2d/500 --only am-samoa/1 --only navajo-rptr/1 --only wash-2d/187 --only ga-app/342 --only ne2d/999 --only ill-app-3d/409 --only f3d/500 --only f-supp-2d/999 --only ny3d/29'
```

```sh
ssh ml-01 'docker logs -f archival-pilot'
```

It should take 10 to 15 minutes. An `--only` entry that isn't on the mirror stops the run
before anything is built, naming the entry.

### Reading the pilot summary

The log ends with the summary, also saved as `runs/<run id>.txt` and `.json`:

```
stare-archival build-all, run 20260929T205448Z: OK
  selected 20: pass 20, uploaded 0, skipped 0, fail 0, error 0, timeout 0, upload failed 0, not run 0
  built 20 volumes, ... pages, ... in ... min with 20 workers: ... pages/s, ... pages/s per worker (build ... ms/page, verify ... ms/page, upload 0 s in all)
```

- `OK` means every selected volume passed or was already done. `INCOMPLETE` lists each
  problem below the counts.
- `fail` is a volume that built but failed a check. Its line names the checks with their
  failure counts, e.g. `FAIL a2d/152: image_pixels (1)`. The manifest, with every failure's
  page, METS order, printed label and message, is `failed/<reporter>/<volume>.json`, and the
  failing PDF is beside it. Nothing that failed is in `cap-pdf/`. Any `image_pixels`,
  `no_jbig2_globals` or `text_layer` failure is a builder bug: stop and report it before the
  full run.
- `error` is a volume that couldn't be built or verified at all (a truncated tar, a METS
  problem); the message is on its line and in `failed/<reporter>/<volume>.json`.
- `timeout` is a volume killed after `--timeout` (default 3600 s).
- `pages/s per worker` is the number to project from: the full run takes about
  39,000,000 / (that figure x workers) seconds. On the test laptop it was 8.8 (f3d/500) to
  22.7 (a2d/152) pages/s for one worker, and about 12 per worker with 8 workers on 8 cores.
- `failing checks (volumes)` counts the volumes failing each check across the run.

The newest JSON summary, with per-volume timings:

```sh
ssh ml-01 'docker run --rm --entrypoint sh -v codexpublicus-derived:/out:ro stare-archival:current -c "ls -t /out/runs/*.json | head -1 | xargs cat"'
```

PDF/A-3b validation with the pinned veraPDF image (the batch doesn't run veraPDF; it takes
about a minute a volume). Expect one `PASS ... 3b` line per PDF:

```sh
ssh ml-01 'docker run --rm --network=none -v codexpublicus-derived:/out:ro verapdf/cli:v1.30.2@sha256:d5ee329657cf9bc4b2400392dd54c7d0a0ce9980ff6fa2da5590eebeec007cdb --flavour 3b --format text --recurse /out/cap-pdf'
```

Then remove the pilot container:

```sh
ssh ml-01 'docker rm archival-pilot'
```

## 4. Full run (detached)

```sh
ssh ml-01 'docker run -d --name archival-full --init -e STARE_ARCHIVAL_IMAGE="$(docker image inspect --format "{{.Id}}" stare-archival:current)" -v codexpublicus-cap-mirror:/mirror:ro -v codexpublicus-derived:/out stare-archival:current build-all --src /mirror/downloads --out /out --work /tmp/archival-work --jobs 32'
```

Progress, one line per volume (`[done/total] STATUS reporter/volume ...`):

```sh
ssh ml-01 'docker logs --tail 20 archival-full'
```

The exit code once it's finished (0 all passed, 1 something failed, 130 stopped):

```sh
ssh ml-01 'docker wait archival-full'
```

The summary is the end of the log and `runs/<run id>.{txt,json}`, read as for the pilot;
`runs/<run id>.jsonl` has a line per volume as each finishes, so an interrupted run still
has its record.

Volumes whose tar aria2 is still downloading (a `.tar.aria2` beside it) are left out of the
run; a later run picks them up.

## 5. Stopping and resuming

To stop, give the runner time to kill its workers and write the summary:

```sh
ssh ml-01 'docker stop -t 60 archival-full'
```

To resume after a stop, a crash or a reboot, remove the old container and start the same
command as in step 4 again:

```sh
ssh ml-01 'docker rm archival-full'
```

A volume is skipped when `cap-pdf/_manifests/<reporter>/<volume>.json` passed for the
tar's current SHA-256 (the mirror's `.tar.sha256`) with the same commit and tool versions,
and its PDF is there with the manifest's SHA-256. Everything else runs again: failed,
errored and timed-out volumes, the ones that were running when it stopped (their half-made
files are removed), and any volume whose tar changed. To retry one volume by hand:

```sh
ssh ml-01 'docker run --rm --init -e STARE_ARCHIVAL_IMAGE="$(docker image inspect --format "{{.Id}}" stare-archival:current)" -v codexpublicus-cap-mirror:/mirror:ro -v codexpublicus-derived:/out stare-archival:current build a2d/152 --src /mirror/downloads --out /out --work /tmp/archival-work'
```

## 6. Upload to codex-data

Pulumi only from a checkout on current `origin/main` (codexpublicus/infra's rule):

```sh
git -C ~/projects/lokkju/codexpublicus-infra pull --ff-only origin main
```

Create the key file on ml-01. The keys go from Pulumi through ssh's stdin into a mode-600
file there, the same method as #42's upload:

```sh
printf 'RCLONE_CONFIG_R2_TYPE=s3\nRCLONE_CONFIG_R2_PROVIDER=Cloudflare\nRCLONE_CONFIG_R2_ACCESS_KEY_ID=%s\nRCLONE_CONFIG_R2_SECRET_ACCESS_KEY=%s\nRCLONE_CONFIG_R2_ENDPOINT=%s\nRCLONE_CONFIG_R2_NO_CHECK_BUCKET=true\n' "$(pulumi -C ~/projects/lokkju/codexpublicus-infra/pulumi stack output codex_data_rw_key_id --show-secrets --stack prod)" "$(pulumi -C ~/projects/lokkju/codexpublicus-infra/pulumi stack output codex_data_rw_key_secret --show-secrets --stack prod)" "$(pulumi -C ~/projects/lokkju/codexpublicus-infra/pulumi stack output codex_data_r2_endpoint --show-secrets --stack prod)" | ssh ml-01 'umask 077 && cat > ~/codex-data-rw.env && ls -l ~/codex-data-rw.env'
```

Dry run first (lists what it would copy, uploads nothing):

```sh
ssh ml-01 'docker run --rm --init --env-file ~/codex-data-rw.env -v codexpublicus-derived:/out:ro --entrypoint rclone stare-archival:current copy /out/cap-pdf r2:codex-data/cap-pdf --dry-run --s3-upload-cutoff 4G 2>&1 | tail -8'
```

The upload, detached. `--s3-upload-cutoff 4G` sends each file as one PUT, so R2's ETag is an
MD5 it computed itself, which the check below compares; the local copy stays:

```sh
ssh ml-01 'docker run -d --name archival-upload --init --env-file ~/codex-data-rw.env -v codexpublicus-derived:/out:ro --entrypoint rclone stare-archival:current copy /out/cap-pdf r2:codex-data/cap-pdf --checksum --s3-upload-cutoff 4G --transfers 16 --checkers 32 --stats 1m --stats-one-line'
```

```sh
ssh ml-01 'docker logs --tail 5 archival-upload'
```

If it stops, `docker rm archival-upload` and start it again; `copy --checksum` skips what's
already there with the same MD5.

Check every local file against the bucket (expect `0 differences found`):

```sh
ssh ml-01 'docker run --rm --init --env-file ~/codex-data-rw.env -v codexpublicus-derived:/out:ro --entrypoint rclone stare-archival:current check --one-way /out/cap-pdf r2:codex-data/cap-pdf 2>&1 | tail -5'
```

Remove the key file and the finished container:

```sh
ssh ml-01 'shred -u ~/codex-data-rw.env && docker rm archival-upload'
```

## Streaming mode (a machine without the share)

With `--upload r2:codex-data`, each volume is uploaded as soon as it verifies: the PDF, then
its manifest, each checked by remote size and MD5. The runner writes a receipt to
`uploaded/<reporter>/<volume>.json` and deletes the local PDF, keeping the manifest. A
volume with a matching receipt counts as done without its PDF; a failed upload keeps the
PDF, and the next run uploads it without rebuilding. `--max-local-bytes` holds new volumes
back while the PDFs waiting on local disk plus each running volume's tar size would pass the
limit, and stops the run (`stopped: disk guard ...`) if nothing is running and there's still
no room. For example, into a local directory with a 300 GiB ceiling:

```sh
ssh ml-01 'docker run -d --name archival-stream --init --env-file ~/codex-data-rw.env -e STARE_ARCHIVAL_IMAGE="$(docker image inspect --format "{{.Id}}" stare-archival:current)" -v codexpublicus-cap-mirror:/mirror:ro -v /nvme/archival-pdf:/out stare-archival:current build-all --src /mirror/downloads --out /out --work /tmp/archival-work --jobs 32 --upload r2:codex-data --max-local-bytes 300G'
```

In this mode each PDF's record is the size and MD5 check made when it was uploaded, kept in
its receipt; the PDFs are gone from local disk, so the `rclone check --one-way` of step 6
covers only the manifests still there.
