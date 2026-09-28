"""Guards the pulumi-cloudflare pin, which must match codexpublicus-infra and lokkju-infra."""

from pathlib import Path


def test_cloudflare_provider_is_pinned():
    pyproject = Path(__file__).parent.parent / "pyproject.toml"
    assert "pulumi-cloudflare==6.13.0" in pyproject.read_text()
