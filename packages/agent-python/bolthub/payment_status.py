"""Payment-status taxonomy emitted by bolthub gateways.

When ``GATEWAY_PAYMENT_STATUS_HEADERS`` is enabled on the gateway, every
paid-path response carries ``X-Bolthub-Payment`` (what happened to this
request's money: ``charged`` / ``reverted`` / ``refunded_to_balance`` /
``not_charged``) and, on failures, ``X-Bolthub-Payment-Code``.

``upstream_failed_retryable`` is the load-bearing signal: the payment layer
already gave the money back (per_request: the same preimage redeems again;
session models: the deduction returned to the balance), so re-sending the
identical request with the held credential costs nothing.

Older gateways and gateways with the flag off emit neither header —
:func:`read_payment_status` returns ``None`` and callers must not assume
anything about the payment. Parity with ``@bolthub/pay``'s
``http/payment-status.ts``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping, Optional

from ._engine import L402Error

__all__ = [
    "PAYMENT_HEADER",
    "PAYMENT_CODE_HEADER",
    "PaymentStatus",
    "read_payment_status",
    "UpstreamFailedError",
]

PAYMENT_HEADER = "X-Bolthub-Payment"
PAYMENT_CODE_HEADER = "X-Bolthub-Payment-Code"


@dataclass(frozen=True)
class PaymentStatus:
    """Parsed payment outcome of one gateway response.

    ``state`` and ``code`` are wire-stable strings; a newer gateway may emit
    values this SDK version doesn't know yet, so treat unknowns gracefully.
    """

    state: str
    code: Optional[str] = None


def read_payment_status(headers: Mapping[str, str]) -> Optional[PaymentStatus]:
    """Read the payment-status headers off a response.

    Returns ``None`` when the gateway did not emit them (flag off, older
    gateway, or a non-bolthub server) — in that case nothing may be assumed
    about the payment.
    """
    state = headers.get(PAYMENT_HEADER)
    if not state:
        return None
    return PaymentStatus(state=state, code=headers.get(PAYMENT_CODE_HEADER) or None)


class UpstreamFailedError(L402Error):
    """Raised (opt-in via ``throw_on_upstream_failure``) when the origin kept
    failing after payment and all free retries were exhausted.

    The gateway already un-charged the request — ``payment_status`` says how
    (invoice reverted or deduction refunded) — so retrying later costs
    nothing; ``retryable`` is always ``True`` for this error.
    """

    retryable: bool = True

    def __init__(
        self,
        message: str,
        *,
        payment_status: PaymentStatus,
        http_status: int,
        attempts: int,
        resource: str,
    ):
        super().__init__(message)
        self.payment_status = payment_status
        self.http_status = http_status
        self.attempts = attempts
        self.resource = resource
