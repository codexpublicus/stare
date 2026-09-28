"""Stack configuration for stare-infra, validated before any resource is declared."""

from dataclasses import dataclass
from typing import Any

import pulumi


@dataclass(frozen=True)
class Settings:
    shared_stack: str
    zone: str
    worker_name: str
    github_repo: str
    citare_repo: str
    data_bucket: str
    bucket_location: str


def _require_owner(repo: str) -> str:
    if "/" not in repo or not all(repo.split("/", 1)):
        raise ValueError(f"{repo} is missing an owner (expected owner/repo)")
    return repo


def parse_settings(raw: dict[str, Any]) -> Settings:
    return Settings(
        shared_stack=raw["shared_stack"],
        zone=raw["zone"],
        worker_name=raw["worker_name"],
        github_repo=_require_owner(raw["github_repo"]),
        citare_repo=_require_owner(raw["citare_repo"]),
        data_bucket=raw["data_bucket"],
        bucket_location=raw.get("bucket_location") or "WNAM",
    )


def load_settings(cfg: pulumi.Config) -> Settings:
    required_keys = [
        "shared_stack",
        "zone",
        "worker_name",
        "github_repo",
        "citare_repo",
        "data_bucket",
    ]
    raw: dict[str, Any] = {k: cfg.require(k) for k in required_keys}
    raw["bucket_location"] = cfg.get("bucket_location")
    return parse_settings(raw)
