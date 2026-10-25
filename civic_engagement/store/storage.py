"""Where the sessions and the saved scenarios are kept: named JSON documents
("<directory>/<file>.json"), under a root.

`CIVIC_ENGAGEMENT_STATE` chooses the root: a directory, the current one by
default — so the documents are where they have always been, next to each
site's baseline in data/<site>/. A container whose own disk is read-only
or doesn't outlive it points it elsewhere (/tmp, or later a store outside
it). The site's read-only data (baseline, terrain, preset scenarios) is
read from data/<site>/ whatever the root.
"""

import os
from abc import ABC, abstractmethod
from functools import cache
from pathlib import Path, PurePosixPath


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

    @abstractmethod
    def within(self, directory: str) -> "Storage":
        """The documents under `directory`, named relative to it."""


def _checked(name: str) -> str:
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or not path.parts:
        raise ValueError(f"Not a document name: {name!r}")
    return path.as_posix()


class LocalStorage(Storage):
    """Files in a local directory."""

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)

    @property
    def location(self) -> Path:
        """The directory, resolved: two storages with the same location hold the same files."""
        return self.root.resolve()

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

    def within(self, directory: str) -> "LocalStorage":
        return LocalStorage(self._path(directory))


@cache
def state_storage() -> Storage:
    """The sessions' and saved scenarios' storage (`CIVIC_ENGAGEMENT_STATE`)."""
    return LocalStorage(os.environ.get("CIVIC_ENGAGEMENT_STATE", "."))
