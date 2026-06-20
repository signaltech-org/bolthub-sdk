"""P3 — FileSessionStore._persist deterministic cleanup on failure."""

import glob
import os
import shutil
import tempfile
import time

import pytest
from unittest.mock import patch

from bolthub.session_store import FileSessionStore, SessionData


def _fresh_store():
    d = tempfile.mkdtemp(prefix="bolthub-persist-")
    path = os.path.join(d, "sessions.json")
    return FileSessionStore(file_path=path), d


def _session():
    return SessionData(token="t", expires_at=time.time() + 60)


class TestPersistCleanup:
    def test_rename_failure_reraises_original_and_leaves_no_temp(self):
        store, d = _fresh_store()
        try:
            # os.rename runs AFTER the fd is closed. The old cleanup called
            # os.get_inheritable on the already-closed fd, raising "Bad file
            # descriptor" instead of the real error and leaking the temp file.
            with patch("bolthub.session_store.os.rename", side_effect=OSError("rename boom")):
                with pytest.raises(OSError, match="rename boom"):
                    store.set("k", _session())
            assert glob.glob(os.path.join(d, "*.tmp")) == []
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_write_failure_reraises_original_and_leaves_no_temp(self):
        store, d = _fresh_store()
        try:
            # os.write fails while the fd is still open: cleanup must close it
            # once and unlink the temp file.
            with patch("bolthub.session_store.os.write", side_effect=OSError("disk full")):
                with pytest.raises(OSError, match="disk full"):
                    store.set("k", _session())
            assert glob.glob(os.path.join(d, "*.tmp")) == []
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_happy_path_leaves_no_temp_and_persists(self):
        store, d = _fresh_store()
        try:
            store.set("k", _session())
            assert glob.glob(os.path.join(d, "*.tmp")) == []
            assert os.path.exists(store._file_path)
            assert store.get("k") is not None
        finally:
            shutil.rmtree(d, ignore_errors=True)
