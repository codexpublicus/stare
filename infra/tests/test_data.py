from unittest.mock import patch

import pulumi

from tests.conftest import created  # noqa: F401  (installs the mocks)

from stare_infra import data  # noqa: E402
from stare_infra.settings import parse_settings  # noqa: E402

BUCKET = "cloudflare:index/r2Bucket:R2Bucket"

SETTINGS = parse_settings({
    "shared_stack": "organization/codexpublicus-infra/prod",
    "zone": "stare.pub",
    "worker_name": "stare-pub",
    "github_repo": "codexpublicus/stare",
    "citare_repo": "codexpublicus/citare",
    "data_bucket": "codex-data",
    "bucket_location": "WNAM",
})


def _declare():
    before = len(created)
    bucket = data.declare_data(SETTINGS, "acct-123")
    return before, bucket


def test_data_bucket_options_protect_and_retain():
    opts = data.data_bucket_options()
    assert opts.protect is True
    assert opts.retain_on_delete is True


@pulumi.runtime.test
def test_bucket_receives_protect_and_retain_options():
    """opts=data_bucket_options() must reach the R2Bucket constructor; a helper that
    exists but isn't wired up would leave the real bucket unprotected."""
    real_bucket = data.cloudflare.R2Bucket
    captured = {}

    def wrap_bucket(*args, **kwargs):
        captured["bucket"] = kwargs.get("opts")
        return real_bucket(*args, **kwargs)

    with patch.object(data.cloudflare, "R2Bucket", side_effect=wrap_bucket):
        _, bucket = _declare()

    opts = captured.get("bucket")
    assert opts is not None, "bucket was constructed without an opts kwarg"
    assert opts.protect is True
    assert opts.retain_on_delete is True
    # Wait for this bucket to register so it can't land in a later test's snapshot.
    return bucket.urn


@pulumi.runtime.test
def test_declares_only_the_codex_data_bucket_in_wnam():
    before, bucket = _declare()

    def check(_):
        added = created[before:]
        assert [(t, n) for t, n, _ in added] == [(BUCKET, "r2-codex-data")]
        inputs = added[0][2]
        assert inputs["name"] == "codex-data"
        assert inputs["location"] == "WNAM"
        assert inputs["accountId"] == "acct-123"
        assert not [t for t, _, _ in added if "r2CustomDomain" in t]
        assert not [n for _, n, _ in added if "stare-pub-idx" in n]

    return bucket.urn.apply(check)
