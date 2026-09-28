import pulumi

import tests.conftest  # noqa: F401  (installs the mocks; StackReference yields account_id/zone_id)

from stare_infra.shared import read_shared  # noqa: E402


@pulumi.runtime.test
def test_reads_account_id_and_zone_id_from_the_shared_stack():
    shared = read_shared("organization/codexpublicus-infra/prod")
    return pulumi.Output.all(shared.account_id, shared.zone_id).apply(_check)


def _check(values):
    account_id, zone_id = values
    assert account_id == "acct-123"
    assert zone_id == "zone-123"
