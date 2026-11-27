"""PINs: what a team's member types to join it (`CIVIC_ENGAGEMENT_AUTH=pin`,
see access.py). The mechanism is the core's, the format the pack's
(`DomainPack.pin_format`): what is easy to say and remember depends on the
language and the people.

A PIN is stored as an HMAC of its normalised form, with the deployment's
secret (`CIVIC_ENGAGEMENT_PIN_SECRET`): deterministic, so a PIN is found
by its HMAC, and useless without the secret.

It is also kept sealed — encrypted (AES-GCM) under a key derived from the
same secret — so that the manager can read it again (`seal`, `unseal`):
whoever has the secret can find any PIN from its HMAC anyway, by trying
them all, so the secret guards both alike.
"""

import base64
import hashlib
import hmac
import re
import secrets
from abc import ABC, abstractmethod

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

# The fewest PINs a format must be able to make: what the throttling's
# strength assumes (access.Throttle). The code is public, so the format's
# size is all a guesser faces: with 30 PINs in use, one guess in 33,000
# hits, and one IP, held to a guess every 5 minutes, needs months.
MIN_SIZE = 10**6


class PinFormat(ABC):
    """How a pack's PINs look."""

    # Shown as the login field's hint, e.g. "123456".
    example: str
    # How many PINs the format can make.
    size: int

    @abstractmethod
    def generate(self, taken: set[str]) -> str:
        """A new PIN, its distinct part (see `distinct`) not in `taken`;
        ValueError if every distinct part is taken."""

    @abstractmethod
    def normalise(self, text: str) -> str:
        """What someone typed, as the PIN to check: the forgiving part
        (case, spaces, hyphens...). The same for every way of typing a PIN."""

    def distinct(self, pin: str) -> str:
        """The part that must differ between a site's PINs, kept in clear
        to check it; "" for none (the default)."""
        return ""


class DigitPin(PinFormat):
    """`digits` digits, 6 by default: "042917"."""

    def __init__(self, digits: int = 6) -> None:
        self.digits = digits
        self.size = 10**digits
        self.example = "123456"[:digits].ljust(digits, "0")

    def generate(self, taken: set[str]) -> str:
        return f"{secrets.randbelow(self.size):0{self.digits}d}"

    def normalise(self, text: str) -> str:
        return re.sub(r"\D", "", text)


def checked(pin_format: PinFormat) -> PinFormat:
    if pin_format.size < MIN_SIZE:
        raise ValueError(f"A PIN format must make at least {MIN_SIZE:,} PINs; {type(pin_format).__name__} makes {pin_format.size:,}")
    return pin_format


def pin_hash(secret: bytes, normalised: str) -> str:
    return hmac.new(secret, b"pin\0" + normalised.encode(), hashlib.sha256).hexdigest()


def _seal_key(secret: bytes) -> AESGCM:
    return AESGCM(hmac.new(secret, b"seal\0", hashlib.sha256).digest())


def seal(secret: bytes, member_id: str, pin: str) -> str:
    """The PIN, as it was handed out, encrypted for its member only: a sealed
    PIN copied onto another member doesn't open."""
    nonce = secrets.token_bytes(12)
    sealed = _seal_key(secret).encrypt(nonce, pin.encode(), member_id.encode())
    return base64.urlsafe_b64encode(nonce + sealed).decode()


def unseal(secret: bytes, member_id: str, sealed: str) -> str | None:
    """The PIN; None if there's none (a member from before sealed PINs) or it
    doesn't open (another secret, another member's)."""
    if not sealed:
        return None
    try:
        raw = base64.urlsafe_b64decode(sealed)
        return _seal_key(secret).decrypt(raw[:12], raw[12:], member_id.encode()).decode()
    except (InvalidTag, ValueError, TypeError):
        return None
