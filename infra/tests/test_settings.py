import pytest

from stare_infra.settings import parse_settings

RAW = {
    "shared_stack": "organization/codexpublicus-infra/prod",
    "zone": "stare.pub",
    "worker_name": "stare-pub",
    "github_repo": "codexpublicus/stare",
    "citare_repo": "codexpublicus/citare",
    "data_bucket": "codex-data",
    "bucket_location": "WNAM",
}


def test_parse_settings_reads_all_fields():
    settings = parse_settings(RAW)
    assert settings.shared_stack == "organization/codexpublicus-infra/prod"
    assert settings.zone == "stare.pub"
    assert settings.worker_name == "stare-pub"
    assert settings.github_repo == "codexpublicus/stare"
    assert settings.citare_repo == "codexpublicus/citare"
    assert settings.data_bucket == "codex-data"
    assert settings.bucket_location == "WNAM"


def test_parse_settings_rejects_github_repo_without_owner():
    raw = dict(RAW, github_repo="stare")
    with pytest.raises(ValueError):
        parse_settings(raw)


def test_parse_settings_rejects_citare_repo_without_owner():
    raw = dict(RAW, citare_repo="citare")
    with pytest.raises(ValueError):
        parse_settings(raw)
