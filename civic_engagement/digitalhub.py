"""The DigitalHub platform, through its SDK (the core's `dh` extra): for now,
the S3 credentials of a run that lasts for weeks.

A run's credentials are temporary: S3's (`AWS_*`, with a session token) and
the platform's (`DHCORE_*`), about 5.5 hours. The SDK renews them:
`refresh_token()` gets new ones, the refresh token too, and the old ones stop
working; `get_s3_client()` is a client with the current ones. S3's and the
platform's expire together.

With CIVIC_ENGAGEMENT_S3_CREDENTIALS=digitalhub, the state's S3 client comes
from here (store/storage.py): renewed every CIVIC_ENGAGEMENT_S3_REFRESH_S
seconds, 2 hours by default — well before they expire, and even while the
app is idle, as the refresh token too lapses unused (about a month) — and at
once if S3 answers that they've expired.

A restarted container starts again from the run's variables, which the
platform wrote when the run was created and doesn't update: once renewed,
those no longer work, and the app can't read its state. The platform ends a
run at its second restart anyway: deploy it again (docs/deploy-digitalhub.md).
"""

import importlib
import logging
import os
import threading
import time
from datetime import datetime, timezone

log = logging.getLogger(__name__)

REFRESH_S = 2 * 3600
# After a failed renewal, how soon to try again.
RETRY_S = 300


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Credentials:
    """The S3 client from the SDK (`sdk`, the `digitalhub` module), renewed
    every `interval` seconds once started, and on demand."""

    def __init__(self, sdk=None, interval: float = REFRESH_S) -> None:
        self._sdk = sdk or importlib.import_module("digitalhub")
        self.interval = interval
        self._lock = threading.Lock()
        self._client = self._sdk.get_s3_client()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.renewals = 0
        self.last_renewal: str | None = None
        self.last_error: str | None = None

    def client(self):
        return self._client

    def renew(self, stale=None):
        """New credentials, and a client with them. With `stale`, the client
        that found them expired: if another thread has renewed meanwhile,
        its client, without renewing again (each renewal invalidates the
        last)."""
        with self._lock:
            if stale is not None and stale is not self._client:
                return self._client
            try:
                self._sdk.refresh_token()
                self._client = self._sdk.get_s3_client()
            except Exception as error:
                self.last_error = f"{_now()}: {type(error).__name__}: {error}"
                log.error("Couldn't renew the S3 credentials: %s", error)
                raise
            self.renewals += 1
            self.last_renewal, self.last_error = _now(), None
            log.info("S3 credentials renewed")
            return self._client

    def start(self) -> None:
        """Renewing every `interval` seconds, in the background."""
        if self._thread is None:
            self._thread = threading.Thread(target=self._renewing, name="s3-credentials", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _renewing(self) -> None:
        wait = self.interval
        while not self._stop.wait(wait):
            try:
                self.renew()
                wait = self.interval
            except Exception:  # noqa: BLE001 — logged by renew; tried again soon
                wait = min(self.interval, RETRY_S)

    def status(self) -> dict:
        try:
            expires = self._sdk.get_credentials_and_config().get("AWS_CREDENTIALS_EXPIRATION")
        except Exception as error:  # noqa: BLE001
            expires = f"unknown ({type(error).__name__})"
        return {
            "source": "digitalhub",
            "expires": expires,
            "renewed_every_s": self.interval,
            "renewals": self.renewals,
            "last_renewal": self.last_renewal,
            "last_error": self.last_error,
        }


_credentials: Credentials | None = None
_created = threading.Lock()


def credentials() -> Credentials:
    """The run's credentials, renewing (one per process: a renewal
    invalidates the previous tokens)."""
    global _credentials
    with _created:
        if _credentials is None:
            interval = float(os.environ.get("CIVIC_ENGAGEMENT_S3_REFRESH_S") or REFRESH_S)
            _credentials = Credentials(interval=interval)
            _credentials.start()
        return _credentials


def status() -> dict | None:
    """The credentials' status, if they come from here."""
    return _credentials.status() if _credentials is not None else None
