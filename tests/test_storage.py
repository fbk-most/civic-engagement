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


@pytest.fixture
def s3_storage():
    """A bucket at CIVIC_ENGAGEMENT_TEST_S3 (an endpoint: MinIO, moto's
    server...), with the AWS_* credentials of the environment; skipped
    without one."""
    import os
    import uuid

    endpoint = os.environ.get("CIVIC_ENGAGEMENT_TEST_S3")
    if not endpoint:
        pytest.skip("CIVIC_ENGAGEMENT_TEST_S3 not set")
    boto3 = pytest.importorskip("boto3")
    from civic_engagement.store.storage import S3Storage

    client = boto3.client("s3", endpoint_url=endpoint)
    bucket = f"test-{uuid.uuid4().hex[:8]}"
    client.create_bucket(Bucket=bucket)
    yield S3Storage(bucket, "state/x", client=client)
    for item in client.list_objects_v2(Bucket=bucket).get("Contents", []):
        client.delete_object(Bucket=bucket, Key=item["Key"])
    client.delete_bucket(Bucket=bucket)


def test_documents_in_a_bucket(s3_storage):
    storage = s3_storage
    assert storage.read("a/b.json") is None
    storage.write("a/b.json", b"1")
    storage.write("a/b.json", b"2")
    storage.write("a/c.json", b"3")
    storage.write("a/d/e.json", b"4")
    assert storage.read("a/b.json") == b"2"
    assert storage.names("a") == ["b.json", "c.json"]
    assert storage.names("missing") == []
    assert storage.within("a").read("d/e.json") == b"4"
    assert storage.within("a").names("d") == ["e.json"]
    assert storage.delete("a/c.json") and not storage.delete("a/c.json")
    assert storage.location.endswith("/state/x")
    with pytest.raises(ValueError):
        storage.read("../y.json")
