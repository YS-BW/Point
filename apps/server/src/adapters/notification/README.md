# Notification adapters

External notification is one-way and replaceable. The delivery runtime records a durable `intent`, marks
the delivery `attempting`, calls a `NotificationPort` exactly once, and settles `done`/`failed`/`unknown`.
Adapters never retry, never follow redirects and never claim exactly-once delivery when the provider has no
query/reconcile contract. `unknown` is terminal in this slice.

Port (`apps/server/src/application/delivery.ts`):

```ts
type NotificationResult = {outcome: 'delivered' | 'failed' | 'unknown'; code?: string; status?: number; detail?: {...}};
interface NotificationPort { send(request): Promise<NotificationOutcome | NotificationResult> }
```

Both the historical string outcome and the structured result are accepted; the runtime normalizes with
`notificationOutcome()` and persists only the tri-state (no `code`/`status`/`detail` in Durable state).

## Adapters

| Adapter | File | Use |
|---|---|---|
| memory (test only) | `memory.ts` | Scripted `delivered|failed|unknown|throw`; records calls. Never a real channel. |
| HTTP | `http.ts` | Explicit endpoint, one idempotent POST, frozen status classification. |
| file outbox | `file-outbox.ts` | Durable local sink: one atomic JSON record per delivery id. Local acceptance only. |

No adapter is wired implicitly. `openRuntime(..., {notification})` must receive an explicitly constructed
port; without one the notify task fails closed (`NOTIFICATION_NOT_CONFIGURED`) and the chat delivery is
unaffected.

## HTTP adapter

`createHttpNotificationAdapter({url, token?, timeoutMs?, fetch?})`

- Explicit URL only. `https:` anywhere; `http:` only for `localhost`, `127.0.0.1` or `::1`. URL userinfo is
  rejected. Missing/relative/unsafe URLs throw `HttpNotificationConfigError` before any request.
- `Authorization: Bearer <token>` (only when configured), `Idempotency-Key: <deliveryId>`,
  `content-type: application/json`; token never enters the URL, result, error, detail or logs.
- `redirect: 'manual'`: a 3xx is classified `unknown` (`http-redirect`) and is never forwarded to another
  origin (so Authorization is never replayed cross-origin).
- `AbortSignal` timeout (default 10s, max 10min). Timeout/abort/network/DNS/TLS failures are `unknown`
  (`http-timeout` / `http-network`) and are never retried by the adapter.
- The response body is never read or persisted; it is cancelled immediately.

Frozen classification (`classifyHttpStatus`):

| Status | Outcome | Code |
|---|---|---|
| 2xx | delivered | — (status recorded) |
| 400, 401, 403, 404, 413, 422 | failed | `http-client-error` |
| 408 | unknown | `http-request-timeout` |
| 425 | unknown | `http-too-early` |
| 429 | unknown | `http-rate-limited` |
| 5xx | unknown | `http-server-error` |
| 3xx | unknown | `http-redirect` |
| other | unknown | `http-unclassified` |

`detail` is bounded and redacted (`{classification}` only); no headers, URL, token or provider body.

## File-outbox adapter

`createFileOutboxNotificationAdapter({dir, maxRecordBytes?})`

- Explicit absolute directory; created lazily. Missing/relative configuration throws
  `FileOutboxConfigError`.
- One canonical JSON record per delivery id: `{deliveryId,target,title,text,payloadHash,outcome,code,writtenAt}`.
  Atomic create: 0600 temp file in the same directory -> `fsync` -> hard link to the final name -> `fsync`
  directory. Readers see no record or the complete record, never a partial temp file.
- **The outcome for a committed local record is `unknown` with `code: 'outbox-written'`.** A file in
  this outbox proves only local acceptance; it is deliberately not `delivered`, so the Delivery stays
  `unknown` and a future channel dispatcher/reconcile must settle the remote outcome. It never claims
  exactly-once remote delivery.
- Same delivery id + same canonical payload replays that same `unknown`/`outbox-written` outcome and
  never appends a duplicate. Different payload under the same delivery id returns deterministic
  `failed`/`outbox-conflict` (a result, not a throw, so the runtime does not misclassify it as unknown).
- Corrupt/oversized/symlinked existing records return `failed`/`outbox-corrupt` and are never followed,
  overwritten or deleted. `readOutboxRecord()`/`outboxRecordPath()` expose bounded observation for audits
  and restart checks.
- A written record proves only that the local outbox accepted the notification; it does **not** prove the
  remote channel delivered it. The adapter therefore returns `unknown`/`outbox-written`, and the Delivery
  record remains `unknown` (never `done`) until an explicit remote observation reconciles it.

## Explicit non-goals / unverified

- No real provider is configured here; no exactly-once claim, no provider-specific receipt/query API.
- No automatic retry/backoff/rate-limit handling; `unknown` awaits an explicit future reconcile path.
- No credentials in repository, logs or evidence; token rotation is an operator concern.
- Real network/provider behavior, long-run connection/disk limits, multi-process outbox contention and
  notification reconcile are not verified by this slice.
