"""The codex-data R2 bucket. It starts empty and has no custom domain."""

import pulumi
import pulumi_cloudflare as cloudflare

from stare_infra.settings import Settings


def data_bucket_options(**extra) -> pulumi.ResourceOptions:
    """codex-data will hold processed corpus data; never let Pulumi delete it."""
    return pulumi.ResourceOptions(protect=True, retain_on_delete=True, **extra)


def declare_data(settings: Settings, account_id) -> cloudflare.R2Bucket:
    name = settings.data_bucket
    bucket = cloudflare.R2Bucket(
        f"r2-{name}",
        account_id=account_id,
        name=name,
        location=settings.bucket_location,
        opts=data_bucket_options(),
    )
    pulumi.export(f"r2_bucket_{name}", bucket.name)
    return bucket
