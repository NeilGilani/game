"""Optional encryption at rest for the memory tree.

What is encrypted when it is on: every node label (current and original), node attributes, event
details and summary notes, which is all the text the memory holds. What stays readable: ids,
timestamps, weekday and hour, surfaces and outcomes, and flags (pinned, hidden, sensitive).

The key is 32 random bytes kept in the macOS keychain (service "AGENCY Memory"), never in the
database or the environment. Labels are found again through an HMAC "blind index", so lookups
never need plaintext in the database.

AES-256-GCM comes from the ``cryptography`` package, which is not a coordinator dependency yet
(see os/memory/INTEGRATION_REQUEST.md). Without it, turning encryption on fails loudly instead of
silently storing plaintext.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
import shutil
import subprocess  # noqa: S404 - only the fixed /usr/bin/security binary, no shell
import sys
from pathlib import Path
from typing import Protocol

PREFIX = "enc1:"
KEYCHAIN_SERVICE = "AGENCY Memory"
KEYCHAIN_ACCOUNT = "memory-key"


class EncryptionUnavailable(RuntimeError):
    pass


class Cipher(Protocol):
    @property
    def enabled(self) -> bool: ...

    def index_key(self) -> bytes: ...

    def encrypt(self, plaintext: str) -> str: ...

    def decrypt(self, stored: str) -> str: ...


class NullCipher:
    """No encryption. The blind index still uses a per-install salt so ids aren't guessable hashes."""

    def __init__(self, salt: bytes) -> None:
        self._salt = salt

    @property
    def enabled(self) -> bool:
        return False

    def index_key(self) -> bytes:
        return self._salt

    def encrypt(self, plaintext: str) -> str:
        return plaintext

    def decrypt(self, stored: str) -> str:
        if stored.startswith(PREFIX):
            raise EncryptionUnavailable("The memory is encrypted, but its key isn't available on this Mac.")
        return stored


class AesGcmCipher:
    def __init__(self, key: bytes) -> None:
        if len(key) != 32:
            raise ValueError("the memory key must be 32 bytes")
        try:
            from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        except ImportError as exc:  # pragma: no cover - depends on the environment
            raise EncryptionUnavailable(
                "Encryption needs the 'cryptography' package, which isn't installed in this coordinator."
            ) from exc
        self._aead = AESGCM(key)
        self._index = hmac.new(key, b"agency-memory-blind-index-v1", hashlib.sha256).digest()

    @property
    def enabled(self) -> bool:
        return True

    def index_key(self) -> bytes:
        return self._index

    def encrypt(self, plaintext: str) -> str:
        nonce = os.urandom(12)
        sealed = self._aead.encrypt(nonce, plaintext.encode("utf-8"), b"agency-memory")
        return PREFIX + base64.b64encode(nonce + sealed).decode("ascii")

    def decrypt(self, stored: str) -> str:
        if not stored.startswith(PREFIX):
            return stored
        raw = base64.b64decode(stored[len(PREFIX) :])
        plain: bytes = self._aead.decrypt(raw[:12], raw[12:], b"agency-memory")
        return plain.decode("utf-8")


def blind_index(key: bytes, parent_id: str | None, label: str) -> str:
    normalized = " ".join(label.casefold().split())
    message = f"{parent_id or ''}\x1f{normalized}".encode()
    return hmac.new(key, message, hashlib.sha256).hexdigest()[:32]


class KeychainKeyStore:
    """Reads (or creates) the memory key in the macOS keychain with /usr/bin/security.

    ``keychain`` points at a specific keychain file (tests use a throwaway one); by default the
    person's login keychain is used. Instance 3's native helper may replace this with direct
    Security.framework calls, which avoids putting the new key on a command line once.
    """

    def __init__(self, keychain: Path | None = None, service: str = KEYCHAIN_SERVICE) -> None:
        self.keychain = keychain
        self.service = service

    @staticmethod
    def supported() -> bool:
        return sys.platform == "darwin" and shutil.which("security") is not None

    def _run(self, *args: str) -> subprocess.CompletedProcess[str]:
        cmd = ["/usr/bin/security", *args]
        if self.keychain is not None:
            cmd.append(str(self.keychain))
        return subprocess.run(cmd, capture_output=True, text=True, timeout=10, check=False)  # noqa: S603

    def load(self) -> bytes | None:
        if not self.supported():
            raise EncryptionUnavailable("The keychain is only available on macOS.")
        result = self._run("find-generic-password", "-s", self.service, "-a", KEYCHAIN_ACCOUNT, "-w")
        if result.returncode != 0:
            return None
        return bytes.fromhex(result.stdout.strip())

    def load_or_create(self) -> bytes:
        existing = self.load()
        if existing is not None:
            return existing
        key = secrets.token_bytes(32)
        result = self._run("add-generic-password", "-s", self.service, "-a", KEYCHAIN_ACCOUNT, "-w", key.hex(), "-U")
        if result.returncode != 0:
            raise EncryptionUnavailable("Couldn't save the memory key in the keychain.")
        return key

    def delete(self) -> None:
        self._run("delete-generic-password", "-s", self.service, "-a", KEYCHAIN_ACCOUNT)
