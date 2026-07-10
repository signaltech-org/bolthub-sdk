"""Preimage receipt storage (schema v1, parity with @bolthub/pay).

Every settled L402 payment yields an ``(invoice, payment_hash, preimage)``
triple that proves the payment to anyone, offline. A receipt records that
triple with the spend context; a receipt file is a verifiable expense
report for agent spend. Schema reference:
``docs/design/agent-features/SPIKE-8-receipt-schema.md``.

Opt-in by construction: no store configured on the client, nothing written.
Receipt files carry live preimages; treat them like credentials.
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
from dataclasses import dataclass, asdict, replace
from datetime import datetime
from pathlib import Path
from typing import Iterator, Optional, Protocol

__all__ = [
    "Receipt",
    "ReceiptStore",
    "InMemoryReceiptStore",
    "FileReceiptStore",
    "complete_receipt",
    "export_receipts",
]


@dataclass(frozen=True)
class Receipt:
    """One paid call. Field order is also the CSV column order."""

    receipt_v: int
    ts: str
    resource: str
    method: str
    amount_sats: int
    payment_hash: str
    preimage: str
    invoice: str
    outcome: str


def complete_receipt(receipt: Receipt) -> Receipt:
    """Fill ``payment_hash`` from the preimage when the caller didn't know it."""
    if receipt.payment_hash:
        return receipt
    try:
        digest = hashlib.sha256(bytes.fromhex(receipt.preimage)).hexdigest()
    except ValueError:
        return receipt
    return replace(receipt, payment_hash=digest)


class ReceiptStore(Protocol):
    """Pluggable sink for payment receipts."""

    def append(self, receipt: Receipt) -> None: ...
    def list(
        self,
        *,
        from_ts: Optional[datetime] = None,
        to_ts: Optional[datetime] = None,
    ) -> list[Receipt]: ...


def _in_range(
    receipt: Receipt, from_ts: Optional[datetime], to_ts: Optional[datetime]
) -> bool:
    if from_ts is None and to_ts is None:
        return True
    try:
        t = datetime.fromisoformat(receipt.ts.replace("Z", "+00:00"))
    except ValueError:
        return False
    if from_ts is not None and t < from_ts:
        return False
    if to_ts is not None and t > to_ts:
        return False
    return True


class InMemoryReceiptStore:
    """Keeps receipts in memory; for tests and short-lived scripts."""

    def __init__(self) -> None:
        self._receipts: list[Receipt] = []
        self._lock = threading.Lock()

    def append(self, receipt: Receipt) -> None:
        with self._lock:
            self._receipts.append(complete_receipt(receipt))

    def list(
        self,
        *,
        from_ts: Optional[datetime] = None,
        to_ts: Optional[datetime] = None,
    ) -> list[Receipt]:
        with self._lock:
            return [r for r in self._receipts if _in_range(r, from_ts, to_ts)]


_DEFAULT_PATH = Path.home() / ".bolthub" / "receipts.jsonl"


class FileReceiptStore:
    """Appends receipts to a JSONL file (``~/.bolthub/receipts.jsonl`` by
    default), one JSON object per line, created ``0600``.

    A receipt is money history, so append failures raise rather than
    silently dropping the record. Thread-safe within one process; JSONL
    line appends are atomic enough across processes for a local ledger.
    """

    def __init__(self, file_path: str | os.PathLike | None = None) -> None:
        self._path = Path(file_path) if file_path is not None else _DEFAULT_PATH
        self._lock = threading.Lock()

    def append(self, receipt: Receipt) -> None:
        line = json.dumps(asdict(complete_receipt(receipt))) + "\n"
        with self._lock:
            self._path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            fd = os.open(
                self._path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600
            )
            try:
                os.write(fd, line.encode("utf-8"))
            finally:
                os.close(fd)

    def list(
        self,
        *,
        from_ts: Optional[datetime] = None,
        to_ts: Optional[datetime] = None,
    ) -> list[Receipt]:
        try:
            raw = self._path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return []
        out: list[Receipt] = []
        for line in raw.splitlines():
            if not line.strip():
                continue
            try:
                data = json.loads(line)
                receipt = Receipt(**data)
            except (ValueError, TypeError):
                # A torn or foreign line is skipped, never fatal: the rest
                # of the ledger stays readable.
                continue
            if receipt.receipt_v == 1 and _in_range(receipt, from_ts, to_ts):
                out.append(receipt)
        return out

    def _iter(self) -> Iterator[Receipt]:
        yield from self.list()


_CSV_COLUMNS = (
    "receipt_v",
    "ts",
    "resource",
    "method",
    "amount_sats",
    "payment_hash",
    "preimage",
    "invoice",
    "outcome",
)


def export_receipts(
    receipts: list[Receipt], *, format: str = "json", redact: bool = False
) -> str:
    """Serialize receipts for an expense report.

    ``json`` (default) is a pretty-printed array; ``csv`` follows the
    schema's column order (RFC 4180 quoting via the stdlib csv module).
    ``redact=True`` replaces each preimage with ``REDACTED``: the expense
    record survives, the proof of payment (and residual credential value)
    does not — verifiers report redacted receipts as "redacted", not
    "invalid".
    """
    rows = (
        [replace(r, preimage="REDACTED") for r in receipts] if redact else receipts
    )
    if format == "json":
        return json.dumps([asdict(r) for r in rows], indent=2)
    if format != "csv":
        raise ValueError(f"export_receipts: unknown format {format!r} (json|csv)")
    import csv
    import io

    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow(_CSV_COLUMNS)
    for r in rows:
        data = asdict(r)
        writer.writerow([data[c] for c in _CSV_COLUMNS])
    return buf.getvalue()
