"""Pulumi mocks shared by every test. Each test snapshots len(created) first and reads only what it added."""

import asyncio

import pulumi

created: list[tuple[str, str, dict]] = []

# The engine wraps any property that traces back to a secret Output (such as
# email_destination, read with require_secret) in this envelope before a mock ever sees
# it. unwrap_secret() strips it so a test can assert on the plain value underneath.
_SECRET_SIG_KEY = "4dabf18193072939515e22adb298388d"
_SECRET_SIG = "1b47061264138c4ac30d75fd1eb44270"


def unwrap_secret(value):
    if isinstance(value, dict) and value.get(_SECRET_SIG_KEY) == _SECRET_SIG:
        return value["value"]
    return value

_PERMISSION_GROUPS = [
    {"name": "Workers R2 Storage Bucket Item Read", "id": "read-id"},
    {"name": "Workers R2 Storage Bucket Item Write", "id": "write-id"},
    {"name": "Workers Scripts Write", "id": "workers-scripts-write-id"},
    {"name": "Workers Routes Write", "id": "workers-routes-write-id"},
    {"name": "Zone Read", "id": "zone-read-id"},
]

_PERMISSION_GROUPS_TOKEN = (
    "cloudflare:index/getAccountApiTokenPermissionGroupsList:getAccountApiTokenPermissionGroupsList"
)


class _Mocks(pulumi.runtime.Mocks):
    def new_resource(self, args: pulumi.runtime.MockResourceArgs):
        created.append((args.typ, args.name, dict(args.inputs)))
        outputs = dict(args.inputs)
        if args.typ == "pulumi:pulumi:StackReference":
            outputs["outputs"] = {
                "account_id": "acct-123",
                "zone_id_stare.pub": "zone-123",
            }
        elif args.typ == "cloudflare:index/accountToken:AccountToken":
            outputs["value"] = "token-value"
        elif args.typ == "random:index/randomPassword:RandomPassword":
            outputs["result"] = "x" * 48
        elif args.typ == "tls:index/privateKey:PrivateKey":
            outputs["publicKeyOpenssh"] = "ssh-ed25519 AAAA test"
            outputs["privateKeyOpenssh"] = "-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n"
        return [f"{args.name}_id", outputs]

    def call(self, args: pulumi.runtime.MockCallArgs):
        if args.token == _PERMISSION_GROUPS_TOKEN:
            return {"results": _PERMISSION_GROUPS}
        return {}


mocks = _Mocks()
pulumi.runtime.set_mocks(mocks, project="stare-infra", preview=False)


async def settle(quiet_ticks: int = 200, max_ticks: int = 1000) -> None:
    """Yield control until `created` stops growing for `quiet_ticks` consecutive ticks.

    A resource whose registration depends on an output (such as a sibling zone_id)
    resolves as a separate callback racing anything else waiting on that same output,
    including a test's own check(). Reading `created` synchronously right after the
    output resolves can see it before every sibling has landed. Zero-duration yields
    (`asyncio.sleep(0)`), the same idiom pulumi's own `wait_for_rpcs()` uses internally,
    let every ready callback run without a wall-clock wait. Bounded so a registration
    that never completes fails fast instead of hanging the test.
    """
    stable = 0
    last = len(created)
    for _ in range(max_ticks):
        await asyncio.sleep(0)
        current = len(created)
        if current == last:
            stable += 1
            if stable >= quiet_ticks:
                return
        else:
            stable = 0
            last = current
    raise AssertionError(f"created did not stabilize after {max_ticks} ticks")
