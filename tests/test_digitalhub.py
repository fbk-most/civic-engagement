"""S3 credentials renewed through the DigitalHub SDK (civic_engagement/digitalhub.py),
against stand-ins for the SDK and S3."""

import io
import time
from types import SimpleNamespace

import pytest

pytest.importorskip("botocore")
from botocore.exceptions import ClientError  # noqa: E402

from civic_engagement import digitalhub  # noqa: E402
from civic_engagement.store import storage  # noqa: E402


def _error(code: str) -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": code}}, "Operation")


class NoSuchKey(ClientError):
    def __init__(self):
        super().__init__({"Error": {"Code": "NoSuchKey", "Message": ""}}, "GetObject")


class SDK:
    """The SDK as the core uses it: every refresh gives credentials of a new
    generation and invalidates the earlier ones; `expire()` the current."""

    def __init__(self):
        self.objects: dict[str, bytes] = {}
        self.generation = 0
        self.valid_from = 0
        self.refreshes = 0
        self.failing = False

    def get_s3_client(self):
        return S3(self, self.generation)

    def refresh_token(self):
        if self.failing:
            raise RuntimeError("the core is down")
        self.refreshes += 1
        self.generation += 1
        self.valid_from = self.generation

    def expire(self):
        self.valid_from = self.generation + 1

    def get_credentials_and_config(self):
        return {"AWS_CREDENTIALS_EXPIRATION": f"generation {self.generation}"}


class S3:
    exceptions = SimpleNamespace(NoSuchKey=NoSuchKey, ClientError=ClientError)

    def __init__(self, sdk: SDK, generation: int):
        self.sdk, self.generation = sdk, generation

    def _check(self):
        if self.generation < self.sdk.valid_from:
            raise _error("ExpiredToken")

    def put_object(self, Bucket, Key, Body, ContentType):
        self._check()
        self.sdk.objects[Key] = Body

    def get_object(self, Bucket, Key):
        self._check()
        if Key not in self.sdk.objects:
            raise NoSuchKey()
        return {"Body": io.BytesIO(self.sdk.objects[Key])}


def _storage(sdk: SDK, interval: float = 3600) -> tuple[storage.S3Storage, digitalhub.Credentials]:
    credentials = digitalhub.Credentials(sdk=sdk, interval=interval)
    return storage.S3Storage("bucket", "state", credentials=credentials), credentials


def test_expired_credentials_are_renewed_and_the_call_made_again():
    sdk = SDK()
    store, credentials = _storage(sdk)
    store.write("a.json", b"1")
    sdk.expire()
    store.write("a.json", b"2")
    assert store.read("a.json") == b"2" and store.read("missing.json") is None
    assert sdk.refreshes == 1 and credentials.renewals == 1 and credentials.last_error is None


def test_one_renewal_for_many_who_found_them_expired():
    sdk = SDK()
    credentials = digitalhub.Credentials(sdk=sdk)
    stale = credentials.client()
    fresh = credentials.renew(stale=stale)
    assert credentials.renew(stale=stale) is fresh and sdk.refreshes == 1


def test_other_errors_are_not_a_reason_to_renew():
    sdk = SDK()
    store, _ = _storage(sdk)

    def denied(client):
        raise _error("AccessDenied")

    with pytest.raises(ClientError):
        store._call(denied)
    assert sdk.refreshes == 0


def test_renewed_in_the_background():
    sdk = SDK()
    _, credentials = _storage(sdk, interval=0.01)
    credentials.start()
    try:
        deadline = time.monotonic() + 5
        while credentials.renewals < 2 and time.monotonic() < deadline:
            time.sleep(0.01)
    finally:
        credentials.stop()
    assert credentials.renewals >= 2
    assert credentials.status()["expires"] == f"generation {sdk.generation}"


def test_a_failed_renewal_is_reported():
    sdk = SDK()
    store, credentials = _storage(sdk)
    sdk.failing = True
    sdk.expire()
    with pytest.raises(RuntimeError):
        store.write("a.json", b"1")
    assert "the core is down" in credentials.status()["last_error"]
    sdk.failing = False
    store.write("a.json", b"1")
    assert credentials.status()["last_error"] is None


def test_the_choice_of_credentials(monkeypatch):
    sdk = SDK()
    monkeypatch.setattr(digitalhub, "credentials", lambda: digitalhub.Credentials(sdk=sdk))
    monkeypatch.delenv("CIVIC_ENGAGEMENT_S3_ACCESS_KEY", raising=False)
    monkeypatch.setenv("CIVIC_ENGAGEMENT_S3_CREDENTIALS", "digitalhub")
    store = storage.storage_at("s3://bucket/state")
    store.write("a.json", b"1")
    assert sdk.objects == {"state/a.json": b"1"}
    monkeypatch.setenv("CIVIC_ENGAGEMENT_S3_ACCESS_KEY", "static")
    with pytest.raises(RuntimeError, match="not both"):
        storage.storage_at("s3://bucket/state")
    monkeypatch.setenv("CIVIC_ENGAGEMENT_S3_CREDENTIALS", "aws")
    with pytest.raises(RuntimeError, match="only digitalhub"):
        storage.storage_at("s3://bucket/state")
