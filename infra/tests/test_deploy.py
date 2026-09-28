import json

import pulumi

from tests.conftest import created, unwrap_secret  # noqa: F401  (installs the mocks)

from stare_infra.deploy import declare_deploy  # noqa: E402
from stare_infra.settings import parse_settings  # noqa: E402
from stare_infra.shared import Shared  # noqa: E402

TOKEN = "cloudflare:index/accountToken:AccountToken"
SECRET = "github:index/actionsSecret:ActionsSecret"
GITHUB_PROVIDER = "pulumi:providers:github"
PRIVATE_KEY = "tls:index/privateKey:PrivateKey"
DEPLOY_KEY = "github:index/repositoryDeployKey:RepositoryDeployKey"

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
    shared = Shared(
        account_id=pulumi.Output.from_input("acct-123"),
        zone_id=pulumi.Output.from_input("zone-123"),
    )
    result = declare_deploy(SETTINGS, shared)
    # Gate on every resource declare_deploy created; a single resource's own output
    # resolves before its dependents (the secrets) have registered.
    registered = pulumi.Output.all(*[r.urn for r in result.resources], *result.exports.values())
    return before, result, registered


def _added(before):
    return list(created[before:])


@pulumi.runtime.test
def test_declares_exactly_the_deploy_resources():
    before, _, registered = _declare()

    def check(_):
        kinds = sorted(t for t, _, _ in _added(before))
        assert kinds == sorted([TOKEN, GITHUB_PROVIDER, SECRET, SECRET, SECRET, PRIVATE_KEY, DEPLOY_KEY])
        assert not [t for t in kinds if "r2CustomDomain" in t or "dnsRecord" in t]

    return registered.apply(check)


@pulumi.runtime.test
def test_deploy_token_is_scoped_to_workers_scripts_and_the_stare_zone():
    before, _, registered = _declare()

    def check(_):
        tokens = [(n, i) for t, n, i in _added(before) if t == TOKEN]
        assert [n for n, _ in tokens] == ["workers-token-stare-pub"]
        token = tokens[0][1]
        assert token["name"] == "workers-deploy-stare-pub"
        assert token["accountId"] == "acct-123"
        account, zone = token["policies"]
        assert account["effect"] == "allow"
        assert account["permissionGroups"] == [{"id": "workers-scripts-write-id"}]
        assert json.loads(account["resources"]) == {"com.cloudflare.api.account.acct-123": "*"}
        assert zone["effect"] == "allow"
        assert zone["permissionGroups"] == [{"id": "workers-routes-write-id"}, {"id": "zone-read-id"}]
        assert json.loads(zone["resources"]) == {"com.cloudflare.api.account.zone.zone-123": "*"}

    return registered.apply(check)


@pulumi.runtime.test
def test_github_provider_is_the_codexpublicus_owner():
    before, _, registered = _declare()

    def check(_):
        providers = [(n, i) for t, n, i in _added(before) if t == GITHUB_PROVIDER]
        assert [n for n, _ in providers] == ["github-codexpublicus"]
        assert providers[0][1]["owner"] == "codexpublicus"

    return registered.apply(check)


@pulumi.runtime.test
def test_citare_deploy_key_is_ed25519_and_read_only():
    before, _, registered = _declare()

    def check(_):
        added = _added(before)
        keys = [(n, i) for t, n, i in added if t == PRIVATE_KEY]
        assert [n for n, _ in keys] == ["citare-deploy-key"]
        assert keys[0][1]["algorithm"] == "ED25519"
        deploy_keys = [(n, i) for t, n, i in added if t == DEPLOY_KEY]
        assert [n for n, _ in deploy_keys] == ["citare-deploy-key"]
        dk = deploy_keys[0][1]
        assert dk["repository"] == "citare"
        assert dk["readOnly"] is True
        assert dk["title"] == "stare CI (read-only)"
        assert unwrap_secret(dk["key"]) == "ssh-ed25519 AAAA test"

    return registered.apply(check)


@pulumi.runtime.test
def test_three_stare_repo_secrets_use_value_not_plaintext_value():
    before, _, registered = _declare()

    def check(_):
        secrets = {i["secretName"]: (n, i) for t, n, i in _added(before) if t == SECRET}
        assert set(secrets) == {"CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CITARE_DEPLOY_KEY"}
        for _, inputs in secrets.values():
            assert inputs["repository"] == "stare"
            assert "plaintextValue" not in inputs
        values = {name: unwrap_secret(inputs["value"]) for name, (_, inputs) in secrets.items()}
        assert values["CLOUDFLARE_API_TOKEN"] == "token-value"
        assert values["CLOUDFLARE_ACCOUNT_ID"] == "acct-123"
        assert values["CITARE_DEPLOY_KEY"] == "-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n"

    return registered.apply(check)


@pulumi.runtime.test
def test_exports_the_worker_name():
    _, result, registered = _declare()
    assert sorted(result.exports) == ["worker_name"]

    def check(args):
        assert args[-1] == "stare-pub"

    return registered.apply(check)
