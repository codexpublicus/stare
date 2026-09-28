"""stare-infra: Cloudflare Worker and DNS infrastructure for stare.pub."""

import pulumi

from stare_infra.data import declare_data
from stare_infra.deploy import declare_deploy
from stare_infra.settings import load_settings
from stare_infra.shared import read_shared

config = pulumi.Config()
settings = load_settings(config)
shared = read_shared(settings.shared_stack)

declare_deploy(settings, shared)
declare_data(settings, shared.account_id)
