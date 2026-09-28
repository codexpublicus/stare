"""stare-infra: Cloudflare Worker and DNS infrastructure for stare.pub."""

import pulumi

from stare_infra.settings import load_settings
from stare_infra.shared import read_shared

config = pulumi.Config()
settings = load_settings(config)
shared = read_shared(settings.shared_stack)
