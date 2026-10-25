"""Where the teams, sessions and saved scenarios are kept: named JSON
documents ("<directory>/<file>.json"), under a root.

`CIVIC_ENGAGEMENT_STATE` chooses the root: a directory, the current one by
default — so the documents are where they have always been, next to each
site's baseline in data/<site>/ — or `s3://<bucket>/<prefix>`, any
S3-compatible store, for a container whose own disk doesn't outlive it
(credentials and endpoint from the standard `AWS_*` variables, or
`S3_ENDPOINT_URL`). The site's read-only data (baseline, terrain, preset
scenarios) is read from data/<site>/ whatever the root.

Writes go through to the root before a change is answered. One that fails
(the store unreachable for a while) is kept and retried in the background
(`Retrying`): the change isn't lost, and the store says it's behind.
"""

import logging
import os
import threading
import time
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from functools import cache
from pathlib import Path, PurePosixPath

log = logging.getLogger(__name__)


class Storage(ABC):
    """Named documents. A name is a relative POSIX path ("data/x/session.json")."""

    @abstractmethod
    def read(self, name: str) -> bytes | None:
        """The document, or None if there's none of that name."""

    @abstractmethod
    def write(self, name: str, data: bytes) -> None:
        """Creates or replaces the document, whole: a reader never sees half of it."""

    @abstractmethod
    def delete(self, name: str) -> bool:
        """False if there was none of that name."""

    @abstractmethod
    def names(self, directory: str = "") -> list[str]:
        """The names of the .json documents directly in `directory`, sorted."""

    @property
    @abstractmethod
    def location(self) -> str:
        """Where the documents are: two storages with the same location hold the same documents."""

    def within(self, directory: str) -> "Storage":
        """The documents under `directory`, named relative to it."""
        return _Within(self, _checked(directory))


def _checked(name: str) -> str:
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or not path.parts:
        raise ValueError(f"Not a document name: {name!r}")
    return path.as_posix()


class _Within(Storage):
    def __init__(self, parent: Storage, directory: str) -> None:
        self._parent, self._directory = parent, directory

    def _name(self, name: str) -> str:
        return f"{self._directory}/{_checked(name)}"

    def read(self, name: str) -> bytes | None:
        return self._parent.read(self._name(name))

    def write(self, name: str, data: bytes) -> None:
        self._parent.write(self._name(name), data)

    def delete(self, name: str) -> bool:
        return self._parent.delete(self._name(name))

    def names(self, directory: str = "") -> list[str]:
        return self._parent.names(self._name(directory) if directory else self._directory)

    @property
    def location(self) -> str:
        return f"{self._parent.location}/{self._directory}"


class LocalStorage(Storage):
    """Files in a local directory."""

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)

    @property
    def location(self) -> str:
        return self.root.resolve().as_posix()

    def _path(self, name: str) -> Path:
        return self.root / _checked(name)

    def read(self, name: str) -> bytes | None:
        try:
            return self._path(name).read_bytes()
        except FileNotFoundError:
            return None

    def write(self, name: str, data: bytes) -> None:
        path = self._path(name)
        path.parent.mkdir(parents=True, exist_ok=True)
        # Written aside and renamed over the old one: a crash mid-write
        # leaves the previous version, not a truncated file.
        partial = path.with_name(f".{path.name}.partial")
        partial.write_bytes(data)
        os.replace(partial, path)

    def delete(self, name: str) -> bool:
        try:
            self._path(name).unlink()
            return True
        except FileNotFoundError:
            return False

    def names(self, directory: str = "") -> list[str]:
        folder = self._path(directory) if directory else self.root
        return sorted(p.name for p in folder.glob("*.json")) if folder.is_dir() else []


class S3Storage(Storage):
    """Objects under a prefix of an S3 bucket. Needs boto3 (the core's `s3`
    extra)."""

    def __init__(self, bucket: str, prefix: str = "", client=None) -> None:
        if client is None:
            import boto3

            # boto3 reads AWS_ENDPOINT_URL itself; S3_ENDPOINT_URL is what
            # some platforms (DigitalHub) set.
            client = boto3.client("s3", endpoint_url=os.environ.get("AWS_ENDPOINT_URL") or os.environ.get("S3_ENDPOINT_URL"))
        self._client, self.bucket, self.prefix = client, bucket, prefix.strip("/")

    @property
    def location(self) -> str:
        return f"s3://{self.bucket}/{self.prefix}"

    def _key(self, name: str) -> str:
        name = _checked(name)
        return f"{self.prefix}/{name}" if self.prefix else name

    def read(self, name: str) -> bytes | None:
        try:
            return self._client.get_object(Bucket=self.bucket, Key=self._key(name))["Body"].read()
        except self._client.exceptions.NoSuchKey:
            return None

    def write(self, name: str, data: bytes) -> None:
        self._client.put_object(Bucket=self.bucket, Key=self._key(name), Body=data, ContentType="application/json")

    def delete(self, name: str) -> bool:
        key = self._key(name)
        try:
            self._client.head_object(Bucket=self.bucket, Key=key)
        except self._client.exceptions.ClientError as error:
            if error.response.get("Error", {}).get("Code") in ("404", "NoSuchKey", "NotFound"):
                return False
            raise
        self._client.delete_object(Bucket=self.bucket, Key=key)
        return True

    def names(self, directory: str = "") -> list[str]:
        prefix = self._key(directory) + "/" if directory else (f"{self.prefix}/" if self.prefix else "")
        names = []
        for page in self._client.get_paginator("list_objects_v2").paginate(Bucket=self.bucket, Prefix=prefix, Delimiter="/"):
            names += [item["Key"][len(prefix):] for item in page.get("Contents", [])]
        return sorted(name for name in names if name.endswith(".json"))


class Retrying(Storage):
    """Another storage, with its failed writes and deletes kept and retried
    in the background, every `interval` seconds, until they go through. In
    the meantime the storage is `behind`, and reads of those documents
    answer what's waiting to be written."""

    def __init__(self, storage: Storage, interval: float = 10.0) -> None:
        self._storage, self._interval = storage, interval
        self._lock = threading.Lock()
        # name → the data waiting to be written, or None for a delete.
        self._pending: dict[str, bytes | None] = {}
        self._retrier: threading.Thread | None = None
        self.last_write: str | None = None
        self.last_error: str | None = None

    @property
    def location(self) -> str:
        return self._storage.location

    @property
    def behind(self) -> list[str]:
        """The documents not yet written."""
        with self._lock:
            return sorted(self._pending)

    def read(self, name: str) -> bytes | None:
        with self._lock:
            if name in self._pending:
                return self._pending[name]
        return self._storage.read(name)

    def write(self, name: str, data: bytes) -> None:
        self._apply(name, data)

    def delete(self, name: str) -> bool:
        existed = self.read(name) is not None
        self._apply(name, None)
        return existed

    def names(self, directory: str = "") -> list[str]:
        names = set(self._storage.names(directory))
        with self._lock:
            for name, data in self._pending.items():
                folder, _, base = name.rpartition("/")
                if folder == directory.strip("/") and base.endswith(".json"):
                    (names.add if data is not None else names.discard)(base)
        return sorted(names)

    def _apply(self, name: str, data: bytes | None) -> None:
        with self._lock:
            # Behind already: queued after the others, never ahead of them.
            if self._pending:
                self._pending[name] = data
                return
        try:
            self._do(name, data)
        except Exception as error:  # noqa: BLE001 — any failure of the store
            self._failed(name, data, error)

    def _do(self, name: str, data: bytes | None) -> None:
        if data is None:
            self._storage.delete(name)
        else:
            self._storage.write(name, data)
        self.last_write = datetime.now(timezone.utc).isoformat(timespec="seconds")

    def _failed(self, name: str, data: bytes | None, error: Exception) -> None:
        log.error("Couldn't write %s (%s): kept, retried every %g s", name, error, self._interval)
        with self._lock:
            self._pending[name] = data
            self.last_error = f"{name}: {error}"
            if self._retrier is None:
                self._retrier = threading.Thread(target=self._retry, name="storage-retry", daemon=True)
                self._retrier.start()

    def _retry(self) -> None:
        while True:
            time.sleep(self._interval)
            with self._lock:
                pending = list(self._pending.items())
            for name, data in pending:
                try:
                    self._do(name, data)
                except Exception as error:  # noqa: BLE001
                    self.last_error = f"{name}: {error}"
                    break
                with self._lock:
                    # Unless it changed again meanwhile.
                    if self._pending.get(name, ...) is data:
                        del self._pending[name]
            with self._lock:
                if not self._pending:
                    log.warning("The store caught up")
                    self._retrier = None
                    return


def storage_at(root: str) -> Storage:
    """A local directory, or `s3://<bucket>/<prefix>`."""
    if root.startswith("s3://"):
        bucket, _, prefix = root.removeprefix("s3://").partition("/")
        return S3Storage(bucket, prefix)
    return LocalStorage(root)


@cache
def state_storage() -> Retrying:
    """The teams', sessions' and saved scenarios' storage (`CIVIC_ENGAGEMENT_STATE`)."""
    return Retrying(storage_at(os.environ.get("CIVIC_ENGAGEMENT_STATE", ".")))
