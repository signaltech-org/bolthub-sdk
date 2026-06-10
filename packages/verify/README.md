# @bolthub/verify

Verify that incoming requests to your origin server were proxied through the BoltHub gateway. Zero dependencies; uses only Node.js built-in `crypto`.

## Install

```bash
npm install @bolthub/verify
```

## Quick Start (Express)

```typescript
import { expressHmacMiddleware } from "@bolthub/verify";

app.use(
  expressHmacMiddleware({
    secrets: [process.env.HMAC_SECRET!],
  })
);
```

Requests without a valid `X-Gateway-Signature` header are rejected with `403`.

## Verification Methods

BoltHub supports two verification methods:

### HMAC Signature (recommended)

The gateway signs every request with HMAC-SHA256 over the canonical payload
`METHOD\nPATH\nTIMESTAMP\nNONCE\nBODY`. This prevents replay attacks and
body tampering.

```typescript
import { verifyGatewaySignature } from "@bolthub/verify";

const result = verifyGatewaySignature(
  {
    method: req.method,
    path: req.path,
    headers: req.headers,
    body: rawBody,
  },
  { secrets: [process.env.HMAC_SECRET!] }
);

if (!result.valid) {
  return res.status(403).json({ error: result.error });
}
```

### Shared Secret

A simpler method where the gateway sends a static `X-Gateway-Secret` header.
No replay protection, but easier to set up.

```typescript
import { verifyGatewaySecret } from "@bolthub/verify";

const result = verifyGatewaySecret(
  { method: req.method, path: req.path, headers: req.headers },
  { secrets: [process.env.GATEWAY_SECRET!] }
);
```

## Secret Rotation

Both methods accept an array of secrets, allowing zero-downtime rotation:

```typescript
expressHmacMiddleware({
  secrets: [currentSecret, previousSecret],
  maxAgeMs: 30_000,
});
```

The library tries each secret in order and accepts the first match.

## API Reference

| Export | Description |
|--------|-------------|
| `verifyGatewaySignature(request, options)` | Verify HMAC-SHA256 signature headers |
| `verifyGatewaySecret(request, options)` | Verify shared secret header |
| `expressHmacMiddleware(options)` | Express/Connect middleware for HMAC verification |
| `expressSecretMiddleware(options)` | Express/Connect middleware for shared secret verification |
| `VerifyOptions` | Options: `secrets`, `maxAgeMs` |
| `VerifyResult` | Result: `{ valid: boolean; error?: string }` |
| `RequestLike` | Minimal request shape accepted by verify functions |

## License

MIT
