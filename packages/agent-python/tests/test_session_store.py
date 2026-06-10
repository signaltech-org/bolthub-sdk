import os
import shutil
import tempfile
import time

import pytest

from bolthub.session_store import (
    FileSessionStore,
    InMemorySessionStore,
    SessionData,
)


class TestInMemorySessionStore:
    def test_get_set_delete(self):
        store = InMemorySessionStore()
        session = SessionData(token="tok1", expires_at=time.time() + 60)
        store.set("k", session)
        assert store.get("k") is session
        store.delete("k")
        assert store.get("k") is None

    def test_clear(self):
        store = InMemorySessionStore()
        store.set("a", SessionData(token="t1", expires_at=time.time() + 60))
        store.set("b", SessionData(token="t2", expires_at=time.time() + 60))
        store.clear()
        assert store.get("a") is None
        assert store.get("b") is None

    def test_items(self):
        store = InMemorySessionStore()
        store.set("x", SessionData(token="t1", expires_at=time.time() + 60))
        store.set("y", SessionData(token="t2", expires_at=time.time() + 60))
        keys = sorted(k for k, _ in store.items())
        assert keys == ["x", "y"]


class TestFileSessionStore:
    def _tmp_path(self):
        d = tempfile.mkdtemp(prefix="bolthub-test-")
        return os.path.join(d, "sessions.json")

    def test_stores_and_retrieves(self):
        path = self._tmp_path()
        try:
            store = FileSessionStore(file_path=path)
            s = SessionData(token="tok1", expires_at=time.time() + 60, balance=5)
            store.set("host/path", s)
            got = store.get("host/path")
            assert got is not None
            assert got.token == "tok1"
            assert got.balance == 5
        finally:
            shutil.rmtree(os.path.dirname(path), ignore_errors=True)

    def test_returns_none_for_missing(self):
        path = self._tmp_path()
        try:
            store = FileSessionStore(file_path=path)
            assert store.get("no-key") is None
        finally:
            shutil.rmtree(os.path.dirname(path), ignore_errors=True)

    def test_prunes_expired_on_get(self):
        path = self._tmp_path()
        try:
            store = FileSessionStore(file_path=path)
            store.set("old", SessionData(token="t", expires_at=time.time() - 10))
            assert store.get("old") is None
        finally:
            shutil.rmtree(os.path.dirname(path), ignore_errors=True)

    def test_persists_and_reloads(self):
        path = self._tmp_path()
        try:
            store1 = FileSessionStore(file_path=path)
            store1.set("k", SessionData(token="disk", expires_at=time.time() + 60))

            store2 = FileSessionStore(file_path=path)
            got = store2.get("k")
            assert got is not None
            assert got.token == "disk"
        finally:
            shutil.rmtree(os.path.dirname(path), ignore_errors=True)

    def test_prunes_expired_on_load(self):
        path = self._tmp_path()
        try:
            store1 = FileSessionStore(file_path=path)
            store1.set("fresh", SessionData(token="a", expires_at=time.time() + 60))
            store1.set("stale", SessionData(token="b", expires_at=time.time() - 10))

            store2 = FileSessionStore(file_path=path)
            assert store2.get("fresh") is not None
            assert store2.get("stale") is None
        finally:
            shutil.rmtree(os.path.dirname(path), ignore_errors=True)

    def test_delete(self):
        path = self._tmp_path()
        try:
            store = FileSessionStore(file_path=path)
            store.set("k", SessionData(token="t", expires_at=time.time() + 60))
            store.delete("k")
            assert store.get("k") is None
        finally:
            shutil.rmtree(os.path.dirname(path), ignore_errors=True)

    def test_clear(self):
        path = self._tmp_path()
        try:
            store = FileSessionStore(file_path=path)
            store.set("a", SessionData(token="t1", expires_at=time.time() + 60))
            store.set("b", SessionData(token="t2", expires_at=time.time() + 60))
            store.clear()
            assert store.get("a") is None
            assert store.get("b") is None
        finally:
            shutil.rmtree(os.path.dirname(path), ignore_errors=True)
