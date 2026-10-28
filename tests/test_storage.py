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


S3_VARIABLES = (
    "CIVIC_ENGAGEMENT_S3_ACCESS_KEY", "CIVIC_ENGAGEMENT_S3_SECRET_KEY", "CIVIC_ENGAGEMENT_S3_ENDPOINT",
    "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_ENDPOINT_URL", "S3_ENDPOINT_URL",
)


def _s3_client(monkeypatch, **variables):
    pytest.importorskip("boto3")
    from civic_engagement.store.storage import s3_client

    for name in S3_VARIABLES:
        monkeypatch.delenv(name, raising=False)
    for name, value in variables.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setenv("AWS_REGION", "default")
    client = s3_client()
    credentials = client._request_signer._credentials.get_frozen_credentials()
    return client.meta.endpoint_url, credentials.access_key, credentials.secret_key, credentials.token


def test_s3_credentials_of_our_own_beat_the_platforms(monkeypatch):
    platform = {
        "AWS_ACCESS_KEY_ID": "temporary", "AWS_SECRET_ACCESS_KEY": "temporary-secret",
        "AWS_SESSION_TOKEN": "session", "AWS_ENDPOINT_URL": "https://platform.example.org",
    }
    assert _s3_client(monkeypatch, **platform) == ("https://platform.example.org", "temporary", "temporary-secret", "session")
    ours = {"CIVIC_ENGAGEMENT_S3_ACCESS_KEY": "static", "CIVIC_ENGAGEMENT_S3_SECRET_KEY": "static-secret"}
    assert _s3_client(monkeypatch, **platform, **ours) == ("https://platform.example.org", "static", "static-secret", None)
    assert _s3_client(monkeypatch, **platform, **ours, CIVIC_ENGAGEMENT_S3_ENDPOINT="https://ours.example.org")[0] == "https://ours.example.org"
    with pytest.raises(RuntimeError):
        _s3_client(monkeypatch, CIVIC_ENGAGEMENT_S3_ACCESS_KEY="static")


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
