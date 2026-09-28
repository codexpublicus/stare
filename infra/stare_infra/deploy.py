"""stare.pub's CI deploy credentials: the Workers deploy token, the citare deploy key, and
the three stare repo secrets that carry them.

Wrangler owns the Worker itself, deployed from stare's GitHub Actions. Pulumi owns only
what that workflow needs to run. The deploy token has two policies, as in
codexpublicus/infra's site.py: Workers Scripts Write on the account covers the script and
asset upload and the Custom Domain; on stare.pub's zone only, Zone Read lets Wrangler
resolve the zone id from the hostname and Workers Routes Write covers its check of the
zone's existing routes.

citare is a private repo stare's build depends on. CI clones it with a read-only deploy
key: Pulumi generates the ED25519 pair, registers the public half on citare and stores the
private half as `CITARE_DEPLOY_KEY` on stare.

`declare_deploy` returns a `Deploy` so a test can wait on every resource it declares, not
just one resource's own output (see site.py's module docstring for why that matters).
"""

import json
from dataclasses import dataclass

import pulumi
import pulumi_cloudflare as cloudflare
import pulumi_github as github
import pulumi_tls as tls

from stare_infra.settings import Settings
from stare_infra.shared import Shared

WORKERS_SCRIPTS_WRITE = "Workers Scripts Write"
WORKERS_ROUTES_WRITE = "Workers Routes Write"
ZONE_READ = "Zone Read"


@dataclass(frozen=True)
class Deploy:
    resources: list[pulumi.CustomResource]
    exports: dict[str, pulumi.Output]


def declare_deploy(settings: Settings, shared: Shared) -> Deploy:
    account_id = shared.account_id
    groups = cloudflare.get_account_api_token_permission_groups_list_output(account_id=account_id)
    by_name = groups.results.apply(lambda results: {g["name"]: g["id"] for g in results})

    def group(name: str) -> dict:
        return {"id": by_name.apply(lambda m: m[name])}

    worker = settings.worker_name
    token = cloudflare.AccountToken(
        f"workers-token-{worker}",
        account_id=account_id,
        name=f"workers-deploy-{worker}",
        policies=[
            {
                "effect": "allow",
                "permission_groups": [group(WORKERS_SCRIPTS_WRITE)],
                "resources": account_id.apply(
                    lambda acct: json.dumps({f"com.cloudflare.api.account.{acct}": "*"})
                ),
            },
            {
                "effect": "allow",
                "permission_groups": [group(WORKERS_ROUTES_WRITE), group(ZONE_READ)],
                "resources": shared.zone_id.apply(
                    lambda zone_id: json.dumps({f"com.cloudflare.api.account.zone.{zone_id}": "*"})
                ),
            },
        ],
        # Same as codexpublicus/infra's site.py (infra#19): the provider reports the
        # policies as changed on every preview with no code change behind it, so without
        # this every `pulumi up` would touch the token.
        opts=pulumi.ResourceOptions(ignore_changes=["policies"]),
    )

    owner, stare_repo = settings.github_repo.split("/")
    citare_owner, citare_repo = settings.citare_repo.split("/")
    if citare_owner != owner:
        raise ValueError(f"{settings.citare_repo} is not under {owner}; one GitHub provider serves both")
    gh = github.Provider(f"github-{owner}", owner=owner)
    opts = pulumi.ResourceOptions(provider=gh)

    secret_token = github.ActionsSecret(
        f"gh-secret-cf-token-{worker}", repository=stare_repo,
        secret_name="CLOUDFLARE_API_TOKEN", value=token.value, opts=opts,
    )
    secret_account = github.ActionsSecret(
        f"gh-secret-cf-account-{worker}", repository=stare_repo,
        secret_name="CLOUDFLARE_ACCOUNT_ID", value=account_id, opts=opts,
    )

    key = tls.PrivateKey("citare-deploy-key", algorithm="ED25519")
    deploy_key = github.RepositoryDeployKey(
        "citare-deploy-key",
        repository=citare_repo,
        title="stare CI (read-only)",
        key=key.public_key_openssh,
        read_only=True,
        opts=opts,
    )
    secret_deploy_key = github.ActionsSecret(
        f"gh-secret-citare-deploy-key-{worker}", repository=stare_repo,
        secret_name="CITARE_DEPLOY_KEY", value=key.private_key_openssh, opts=opts,
    )

    exports: dict[str, pulumi.Output] = {"worker_name": pulumi.Output.from_input(worker)}
    for name, value in exports.items():
        pulumi.export(name, value)
    return Deploy(
        resources=[token, secret_token, secret_account, key, deploy_key, secret_deploy_key],
        exports=exports,
    )
