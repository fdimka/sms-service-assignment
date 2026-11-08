# Local provider contract

The assignment mentions a supplied mock provider but does not attach it. This
document describes the substitute included here. It is an integration seam, not
a claim about an unseen vendor's API. Employee identity and contact records
remain in the local service; the provider still receives only the destination
and message body. Its API and mock scenarios are unchanged.

## POST /sms

Request headers: `Content-Type: application/json` and a required
`Idempotency-Key`. The service sends its own message UUID as that key.

```json
{ "to": "+972501234567", "body": "The irrigation check is complete." }
```

An accepted request returns HTTP 202:

```json
{ "id": "provider-message-id", "status": "accepted" }
```

The same key with the same payload returns the original provider ID, without
creating another send. Reusing it with changed content returns 409. Records and
keys are kept in memory for this development substitute only.

An explicit non-accepted rejection returns HTTP 422 with `{ "code": "REJECTED" }`.
Only that defined response is mapped to `failed`. A timeout, network failure,
unexpected status or malformed success payload is mapped to `unknown`; it is not
proof that no SMS was accepted. The adapter does not follow redirects.

## GET /sms/:id

Return HTTP 200 with the matching ID and one of `accepted`, `delivered`, `failed`:

```json
{ "id": "provider-message-id", "status": "delivered" }
```

Return 404 for a missing ID. The service maps that to `unknown`, not `delivered`
or an automatic resend. Other lookup errors leave the message accepted so that
a later worker cycle can retry the read. Provider-reported delivery is not a
read receipt from a person.

## Deterministic scenarios

| Destination | Behaviour |
|---|---|
| `+972501234567` | Accepted, then delivered after about 750 ms |
| `+972501230000` | Rejected immediately with 422 |
| `+972501230001` | Accepted, then delivery fails |
| `+972501230002` | Remains accepted, representing no final receipt yet |

These are illustrative test strings. The substitute never contacts a carrier.
The rules apply to the final three digits. Every other valid number follows the
successful scenario. Restarting the mock loses its records: persisted accepted
messages then receive 404 and become unknown.

## Connecting the supplied provider later

Check its paths, authentication, field mapping, response meanings, idempotency
guarantees and receipt semantics. Change `HttpSmsProvider` and its contract tests
where necessary. The worker depends on `SmsProvider`, so vendor fields do not
need to leak into the public API or database access code.

Set `SMS_PROVIDER_URL` in `.env` only after confirming compatibility. Setting it
disables the bundled listener. A URL with a path prefix is supported, for example
`http://127.0.0.1:8080/api`, which produces `/api/sms` requests. No credentials or
tokens are required by the substitute; authentication for another API would be
part of its adapter.
