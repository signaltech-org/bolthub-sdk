# bolthub-verify

Verify [bolthub](https://bolthub.ai) gateway signatures on your origin server. Supports Flask, Django, and FastAPI out of the box.

## Install

```bash
pip install bolthub-verify
```

## Quick start (Flask)

```python
from bolthub_verify import flask_hmac_middleware

app.before_request(flask_hmac_middleware("your-hmac-secret-from-dashboard"))
```

## Quick start (FastAPI)

```python
from fastapi import Depends
from bolthub_verify import fastapi_hmac_middleware

verify = fastapi_hmac_middleware("your-hmac-secret-from-dashboard")

@app.get("/protected")
async def protected(_=Depends(verify)):
    return {"ok": True}
```

## Quick start (Django)

```python
# settings.py
MIDDLEWARE = [
    "bolthub_verify.django_hmac_middleware",
    # ...
]
BOLTHUB_HMAC_SECRETS = ["current-secret", "previous-secret"]
```

## Secret rotation

Pass an array of secrets (current + previous) to support zero-downtime rotation:

```python
flask_hmac_middleware(["new-secret", "old-secret"])
```

## Low-level API

```python
from bolthub_verify import verify_gateway_signature

result = verify_gateway_signature(
    method="GET",
    path="/v1/data",
    signature=request.headers["X-Gateway-Signature"],
    timestamp=request.headers["X-Gateway-Timestamp"],
    nonce=request.headers["X-Gateway-Nonce"],
    body="",
    secrets="your-secret",
)
if not result.valid:
    print(result.error)
```
