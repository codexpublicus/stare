"""An in-memory stand-in for the bulk-data bucket, served through ``httpx.MockTransport``.

It answers ``ListObjectsV2`` (paged, with continuation tokens) and object GETs with S3's
Range and If-Range behavior, and can be told to misbehave: ignore Range, ignore If-Range,
send short bodies, drop a connection or answer with an error status a set number of times.
"""

from __future__ import annotations

import hashlib
from datetime import date

import httpx

from stare_courtlistener.listing import table_key

LAST_MODIFIED = "2026-09-30T20:24:07.000Z"


def etag(data: bytes) -> str:
    return f'"{hashlib.md5(data).hexdigest()}"'


def objects(export: str = "2026-09-30", tables: tuple[str, ...] = ()) -> dict[str, bytes]:
    """Small distinct bodies for each table of one export."""
    from stare_courtlistener.listing import DEFAULT_TABLES

    return {
        table_key(t, date.fromisoformat(export)): f"{t} {export} ".encode() * 50
        for t in tables or DEFAULT_TABLES
    }


class Bucket:
    """The bucket's HTTP behavior over a dict of key to body."""

    def __init__(
        self,
        contents: dict[str, bytes],
        *,
        page_size: int = 2,
        listed_etags: dict[str, str] | None = None,
        ignore_range: bool = False,
        ignore_if_range: bool = False,
        short: int = 0,
    ) -> None:
        self.objects = contents
        self.page_size = page_size
        self.listed_etags = listed_etags or {}
        self.ignore_range = ignore_range
        self.ignore_if_range = ignore_if_range
        self.short = short
        self.requests: list[httpx.Request] = []
        self.drop: dict[str, int] = {}
        """Key to the number of GETs to answer with a dropped connection."""
        self.status: dict[str, list[int]] = {}
        """Key to statuses to answer GETs with, one per request, before serving it."""
        self.extra_keys: list[str] = []
        """Listed keys that aren't dated table files."""

    def client(self) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(self))

    def gets(self, key: str) -> list[httpx.Request]:
        return [r for r in self.requests if r.url.path.lstrip("/") == key]

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.url.params.get("list-type") == "2":
            return self._list(request)
        key = request.url.path.lstrip("/")
        if key not in self.objects:
            return httpx.Response(404, text="NoSuchKey")
        if self.drop.get(key):
            self.drop[key] -= 1
            raise httpx.ReadError("connection reset", request=request)
        if self.status.get(key):
            return httpx.Response(self.status[key].pop(0), text="error")
        data = self.objects[key]
        tag = etag(data)
        end = len(data) - self.short
        header = request.headers.get("range")
        if_range = request.headers.get("if-range")
        honors = if_range is None or if_range == tag or self.ignore_if_range
        if header and not self.ignore_range and honors:
            start = int(header.removeprefix("bytes=").rstrip("-"))
            return httpx.Response(
                206,
                content=data[start:end],
                headers={
                    "content-range": f"bytes {start}-{len(data) - 1}/{len(data)}",
                    "etag": tag,
                },
            )
        return httpx.Response(200, content=data[:end], headers={"etag": tag})

    def _list(self, request: httpx.Request) -> httpx.Response:
        prefix = request.url.params.get("prefix", "")
        keys = sorted(k for k in [*self.objects, *self.extra_keys] if k.startswith(prefix))
        start = int(request.url.params.get("continuation-token", "0"))
        page = keys[start : start + self.page_size]
        more = start + self.page_size < len(keys)
        contents = "".join(
            f"<Contents><Key>{k}</Key><LastModified>{LAST_MODIFIED}</LastModified>"
            f"<ETag>{self._listed_etag(k).replace(chr(34), '&quot;')}</ETag>"
            f"<Size>{len(self.objects.get(k, b'x'))}</Size></Contents>"
            for k in page
        )
        token = f"<NextContinuationToken>{start + self.page_size}</NextContinuationToken>"
        body = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
            f"<IsTruncated>{'true' if more else 'false'}</IsTruncated>"
            f"{token if more else ''}{contents}</ListBucketResult>"
        )
        return httpx.Response(200, text=body)

    def _listed_etag(self, key: str) -> str:
        if key in self.listed_etags:
            return self.listed_etags[key]
        return etag(self.objects.get(key, b"x"))
