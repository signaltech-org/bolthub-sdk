"""Minimal secp256k1 + BIP-340 Schnorr, vendored for NWC (NIP-47/NIP-04).

Adapted from the public-domain BIP-340 reference implementation
(https://github.com/bitcoin/bips/blob/master/bip-0340/reference.py), with an
added ``ecdh_x`` for the NIP-04 shared secret.

This is pure Python and therefore NOT constant-time. It is used only to sign
ephemeral NWC request events with the connection secret and to verify the
wallet's responses, on the client host — not in a remote-timing-exposed path.
``cryptography`` handles the AES side of NIP-04; this module handles the curve
operations ``cryptography`` does not expose (BIP-340 Schnorr).
"""

from __future__ import annotations

import hashlib

p = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F
n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
G = (
    0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
    0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8,
)

Point = tuple  # (x, y) or None for the point at infinity


def _x(P):
    return P[0]


def _y(P):
    return P[1]


def _point_add(P1, P2):
    if P1 is None:
        return P2
    if P2 is None:
        return P1
    if _x(P1) == _x(P2) and _y(P1) != _y(P2):
        return None
    if P1 == P2:
        lam = (3 * _x(P1) * _x(P1) * pow(2 * _y(P1), p - 2, p)) % p
    else:
        lam = ((_y(P2) - _y(P1)) * pow(_x(P2) - _x(P1), p - 2, p)) % p
    x3 = (lam * lam - _x(P1) - _x(P2)) % p
    return (x3, (lam * (_x(P1) - x3) - _y(P1)) % p)


def _point_mul(P, k):
    R = None
    for i in range(256):
        if (k >> i) & 1:
            R = _point_add(R, P)
        P = _point_add(P, P)
    return R


def _bytes_from_int(x: int) -> bytes:
    return x.to_bytes(32, byteorder="big")


def _int_from_bytes(b: bytes) -> int:
    return int.from_bytes(b, byteorder="big")


def _has_even_y(P) -> bool:
    return _y(P) % 2 == 0


def _lift_x(x: int):
    if x >= p:
        return None
    y_sq = (pow(x, 3, p) + 7) % p
    y = pow(y_sq, (p + 1) // 4, p)
    if pow(y, 2, p) != y_sq:
        return None
    return (x, y if y % 2 == 0 else p - y)


def _tagged_hash(tag: str, msg: bytes) -> bytes:
    tag_hash = hashlib.sha256(tag.encode()).digest()
    return hashlib.sha256(tag_hash + tag_hash + msg).digest()


def _xor_bytes(a: bytes, b: bytes) -> bytes:
    return bytes(x ^ y for x, y in zip(a, b))


def pubkey_gen(seckey: bytes) -> bytes:
    """Return the 32-byte x-only (BIP-340) public key for a 32-byte seckey."""
    d0 = _int_from_bytes(seckey)
    if not (1 <= d0 <= n - 1):
        raise ValueError("secret key out of range")
    P = _point_mul(G, d0)
    return _bytes_from_int(_x(P))


def schnorr_sign(msg: bytes, seckey: bytes, aux_rand: bytes) -> bytes:
    """BIP-340 Schnorr signature over a 32-byte ``msg`` (returns 64 bytes)."""
    if len(msg) != 32:
        raise ValueError("msg must be 32 bytes")
    d0 = _int_from_bytes(seckey)
    if not (1 <= d0 <= n - 1):
        raise ValueError("secret key out of range")
    P = _point_mul(G, d0)
    d = d0 if _has_even_y(P) else n - d0
    t = _xor_bytes(_bytes_from_int(d), _tagged_hash("BIP0340/aux", aux_rand))
    rand = _tagged_hash("BIP0340/nonce", t + _bytes_from_int(_x(P)) + msg)
    k0 = _int_from_bytes(rand) % n
    if k0 == 0:
        raise RuntimeError("nonce generation failed")
    R = _point_mul(G, k0)
    k = k0 if _has_even_y(R) else n - k0
    e = (
        _int_from_bytes(
            _tagged_hash(
                "BIP0340/challenge", _bytes_from_int(_x(R)) + _bytes_from_int(_x(P)) + msg
            )
        )
        % n
    )
    return _bytes_from_int(_x(R)) + _bytes_from_int((k + e * d) % n)


def schnorr_verify(msg: bytes, pubkey: bytes, sig: bytes) -> bool:
    """Verify a BIP-340 Schnorr signature."""
    if len(msg) != 32 or len(pubkey) != 32 or len(sig) != 64:
        return False
    P = _lift_x(_int_from_bytes(pubkey))
    if P is None:
        return False
    r = _int_from_bytes(sig[0:32])
    s = _int_from_bytes(sig[32:64])
    if r >= p or s >= n:
        return False
    e = (
        _int_from_bytes(_tagged_hash("BIP0340/challenge", sig[0:32] + pubkey + msg)) % n
    )
    R = _point_add(_point_mul(G, s), _point_mul(P, n - e))
    if R is None or not _has_even_y(R) or _x(R) != r:
        return False
    return True


def ecdh_x(seckey: bytes, pubkey_xonly: bytes) -> bytes:
    """NIP-04 shared secret: the X coordinate of ``seckey * lift_x(pubkey)``.

    Both parties lift the counterparty's x-only key to even-Y; the resulting
    shared X coordinate is identical regardless of either key's Y parity.
    """
    d = _int_from_bytes(seckey)
    if not (1 <= d <= n - 1):
        raise ValueError("secret key out of range")
    P = _lift_x(_int_from_bytes(pubkey_xonly))
    if P is None:
        raise ValueError("invalid public key")
    S = _point_mul(P, d)
    if S is None:
        raise ValueError("degenerate shared point")
    return _bytes_from_int(_x(S))
