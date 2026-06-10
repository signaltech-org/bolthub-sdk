"""Session token storage backends for the L402 client."""

from __future__ import annotations

import json
import os
import stat
import tempfile
import time
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Protocol, Iterator


@dataclass
class SessionData:
    """A cached gateway session token with expiry and optional balance."""

    token: str
    expires_at: float
    balance: int | None = None


class SessionStore(Protocol):
    """Pluggable storage backend for gateway session tokens.

    The default in-memory store is suitable for short-lived scripts.
    Use :class:`FileSessionStore` for CLI tools or long-running agents
    that should survive restarts.
    """

    def get(self, key: str) -> SessionData | None: ...
    def set(self, key: str, session: SessionData) -> None: ...
    def delete(self, key: str) -> None: ...
    def clear(self) -> None: ...
    def items(self) -> Iterator[tuple[str, SessionData]]: ...


class InMemorySessionStore:
    def __init__(self) -> None:
        self._sessions: dict[str, SessionData] = {}

    def get(self, key: str) -> SessionData | None:
        return self._sessions.get(key)

    def set(self, key: str, session: SessionData) -> None:
        self._sessions[key] = session

    def delete(self, key: str) -> None:
        self._sessions.pop(key, None)

    def clear(self) -> None:
        self._sessions.clear()

    def items(self) -> Iterator[tuple[str, SessionData]]:
        yield from self._sessions.items()


_DEFAULT_DIR = os.path.join(os.path.expanduser("~"), ".bolthub")
_DEFAULT_FILE = "sessions.json"


class FileSessionStore:
    """Persists session tokens to a JSON file on disk.

    Defaults to ``~/.bolthub/sessions.json``. Writes are atomic
    (write-to-temp then rename) and the file is created with ``0600``
    permissions.

    Args:
        file_path: Custom path to the session file.
    """

    def __init__(self, file_path: str | None = None) -> None:
        self._file_path = file_path or os.path.join(_DEFAULT_DIR, _DEFAULT_FILE)
        self._sessions: dict[str, SessionData] = {}
        self._load()

    def get(self, key: str) -> SessionData | None:
        session = self._sessions.get(key)
        if session is None:
            return None
        if session.expires_at <= time.time():
            del self._sessions[key]
            self._persist()
            return None
        return session

    def set(self, key: str, session: SessionData) -> None:
        self._sessions[key] = session
        self._persist()

    def delete(self, key: str) -> None:
        if key in self._sessions:
            del self._sessions[key]
            self._persist()

    def clear(self) -> None:
        self._sessions.clear()
        self._persist()

    def items(self) -> Iterator[tuple[str, SessionData]]:
        yield from self._sessions.items()

    def _load(self) -> None:
        try:
            with open(self._file_path, "r") as f:
                data = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return

        if data.get("v") != 1 or not isinstance(data.get("sessions"), dict):
            return

        now = time.time()
        pruned = False
        for key, raw in data["sessions"].items():
            expires_at = raw.get("expires_at", raw.get("expiresAt", 0))
            token = raw.get("token", "")
            if expires_at > now and token:
                balance = raw.get("balance")
                self._sessions[key] = SessionData(
                    token=token,
                    expires_at=expires_at,
                    balance=balance,
                )
            else:
                pruned = True

        if pruned:
            self._persist()

    def _persist(self) -> None:
        dir_path = os.path.dirname(self._file_path)
        os.makedirs(dir_path, mode=0o700, exist_ok=True)

        sessions_dict: dict[str, dict] = {}
        for key, s in self._sessions.items():
            entry: dict = {"token": s.token, "expiresAt": s.expires_at}
            if s.balance is not None:
                entry["balance"] = s.balance
            sessions_dict[key] = entry

        payload = json.dumps({"v": 1, "sessions": sessions_dict}, indent=2)

        fd, tmp_path = tempfile.mkstemp(dir=dir_path, suffix=".tmp")
        try:
            os.write(fd, payload.encode())
            os.fchmod(fd, stat.S_IRUSR | stat.S_IWUSR)
            os.close(fd)
            os.rename(tmp_path, self._file_path)
        except Exception:
            os.close(fd) if not os.get_inheritable(fd) else None
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
