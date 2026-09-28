"""Values this project reads from codexpublicus-infra, and nothing else reads from there."""

from dataclasses import dataclass

import pulumi


@dataclass(frozen=True)
class Shared:
    account_id: pulumi.Output[str]
    zone_id: pulumi.Output[str]


def read_shared(stack_name: str) -> Shared:
    ref = pulumi.StackReference("codexpublicus-infra", stack_name=stack_name)
    return Shared(
        account_id=ref.require_output("account_id"),
        zone_id=ref.require_output("zone_id_stare.pub"),
    )
