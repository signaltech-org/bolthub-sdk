"""Buyer-side payment errors, shared by :class:`bolthub.budget.Budget` and
:class:`bolthub.tool_client.ToolClient`.

Kept in their own module so ``budget.py`` and ``tool_client.py`` can both raise
them without importing each other. Mirrors ``@bolthub/pay``'s ``src/errors.ts``.
These are distinct from :class:`bolthub.L402Error` (the HTTP client's error
hierarchy) because they guard the TPP/MCP payment path.
"""

from __future__ import annotations

from typing import Any

__all__ = ["PaymentError", "PaymentBudgetError"]


class PaymentError(Exception):
    """Base error for buyer-side payment failures."""

    def __init__(self, message: str, cause: Any = None) -> None:
        super().__init__(message)
        #: The underlying exception, when one triggered this error.
        self.cause = cause


class PaymentBudgetError(PaymentError):
    """Raised when a payment would exceed the configured budget."""
