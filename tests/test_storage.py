import pytest

from civic_engagement.store.storage import LocalStorage


def test_documents_in_a_directory(tmp_path):
    storage = LocalStorage(tmp_path)
    assert storage.read("a/b.json") is None
    storage.write("a/b.json", b"1")
    storage.write("a/b.json", b"2")
    storage.write("a/c.json", b"3")
    storage.write("a/d/e.json", b"4")
    assert storage.read("a/b.json") == b"2"
    assert storage.names("a") == ["b.json", "c.json"]
    assert storage.names("missing") == []
    assert storage.within("a").read("d/e.json") == b"4"
    assert storage.delete("a/c.json") and not storage.delete("a/c.json")
    assert sorted(p.name for p in (tmp_path / "a").iterdir()) == ["b.json", "d"]  # nothing left aside


def test_names_cannot_leave_the_root(tmp_path):
    storage = LocalStorage(tmp_path / "root")
    for name in ("../x.json", "/etc/passwd", "a/../../x.json", ""):
        with pytest.raises(ValueError):
            storage.read(name)
