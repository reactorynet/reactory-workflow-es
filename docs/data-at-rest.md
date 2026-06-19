# Data at rest — the `IDataCodec` seam (H6)

`@reactorynet/workflow-es` persists two **opaque, user-controlled payloads**:

- `WorkflowInstance.data` — the workflow's mutable state object.
- `Event.eventData` — the payload supplied to `host.publishEvent(...)`.

These routinely carry PII and secrets (account numbers, tokens, customer records). H6 adds a single,
provider-agnostic seam — **`IDataCodec`** — through which only those two payloads pass on the way to the
persistence provider (`encode`) and on the way back (`decode`). Everything else is unchanged.

## Baseline: rely on database TDE

The codec is **additive and optional**. The recommended baseline for at-rest protection remains
**Transparent Data Encryption (TDE)** / encrypted volumes at the database layer (Postgres TDE, encrypted
EBS/disk, encrypted backups). The codec is for *application-level* field protection (defence in depth,
or when the DBA/replica/snapshot must not see plaintext). Use both.

## Default: no-op, zero behaviour change

The default binding is `NullDataCodec` — `encode`/`decode` return the value unchanged. With no
`useDataCodec(...)` call, the at-rest bytes are **byte-identical** to the pre-H6 engine. Desktop, dev,
and existing deployments require **no migration** and behave exactly as before.

## Opting in

```ts
import { configureWorkflow, IDataCodec, DataCodecContext } from "@reactorynet/workflow-es";

class MyAesCodec implements IDataCodec {
    async encode(value: any, ctx: DataCodecContext): Promise<any> {
        if (value === undefined || value === null) return value;
        const ct = await encryptWithKms(JSON.stringify(value));      // network/HSM-bound, hence async
        return { __wfes_enc: 1, alg: "aes-256-gcm", ct };            // JSON-compatible envelope
    }
    async decode(value: any, ctx: DataCodecContext): Promise<any> {
        if (value && value.__wfes_enc) return JSON.parse(await decryptWithKms(value.ct));
        return value;                                                // tolerate legacy plaintext rows
    }
}

const config = configureWorkflow({ dataCodecMaxBytes: 1_000_000 }); // optional plaintext size guard
config.useDataCodec(new MyAesCodec());
const host = config.getHost();
```

### Contract a codec must honour

- `decode(encode(x))` deep-equals `x` for any JSON-serialisable `x` (round-trip).
- The return value must be **JSON-compatible** (object | array | string | number | boolean | null) so it
  fits the existing `data`/`eventData` slot / JSON columns — return an **envelope object**, never a raw
  `Buffer`.
- `encode`/`decode` must depend on **nothing but the value** (and, advisorily, the `DataCodecContext`).
- `decode` **must tolerate legacy plaintext** (see migration below).
- `encode`/`decode` may be async (KMS/HSM calls). Errors propagate to the persist/read call site and are
  never swallowed — a failed encode does **not** silently complete the workflow with corrupt data.

## What is and is not encoded

| Encoded (opaque payloads) | NOT encoded (plaintext / queryable / control) |
|---|---|
| `WorkflowInstance.data` | `eventName`, `eventKey`, `eventTime` |
| `Event.eventData` | `status`, `nextExecution`, `createTime`, `completeTime` |
| | `workflowDefinitionId`, `version`, `id` |
| | `concurrencyToken` (C1 optimistic-concurrency) |
| | execution-pointer fields, subscription fields |

Because `eventName`/`eventKey`/`status`/`nextExecution` stay plaintext, `getSubscriptions`, `getEvents`,
`getRunnableInstances`, and `getRunnableEvents` keep matching by index/value with a codec configured — an
event published by name/key still wakes its subscription.

## Where the seam lives — one core boundary

The codec is applied centrally by **`DataCodecRunner`** at the core persistence boundary
(`encodeInstance`/`decodeInstance`/`encodeEvent`/`decodeEvent`). Every call site that crosses
`IPersistenceProvider` (in `workflow-host`, `workflow-queue-worker`, `event-queue-worker`) is wrapped:
encode immediately before `createNewWorkflow`/`persistWorkflow`/`createEvent`, decode immediately after
`getWorkflowInstance`/`getEvent`. **No persistence provider is modified** — memory, sqlite, postgres,
mongodb, mysql, redis, and azure all receive (write) and return (read) the already-encoded value and stay
oblivious to it.

> Memory-provider note: `MemoryPersistenceProvider` stores live references, so the runner restores
> (decodes) the in-memory instance after every write, and the event read path decodes onto a copy — so
> the running engine always sees plaintext while the stored bytes stay encoded.

## Size guard

`WorkflowOptions.dataCodecMaxBytes` (default `0` = unlimited; also settable imperatively via
`config.useDataCodecSizeLimit(n)`) rejects an oversized payload at the same central seam. The limit is
measured on the **UTF-8 JSON byte length of the plaintext** payload *before* encode (so it is meaningful
regardless of ciphertext expansion). An oversized payload throws
`"... payload of N bytes exceeds configured limit of M bytes"` at the persist/publish boundary and no
partial/oversized row is written.

## No plaintext in logs

Core never logs the raw `data`/`eventData` contents (`publishEvent` logs only `eventName`/`eventKey`).
Consumers integrating structured logging must keep payloads out of log/correlation context.

## Migration / legacy plaintext

There is **no migration** for the default no-op. Rows written before a codec was bound remain plaintext;
binding an encrypting codec does **not** retroactively encrypt them. A real codec's `decode` must
therefore tolerate reading legacy plaintext (return it as-is when the envelope marker is absent — see the
example above). This is a consumer responsibility; H6 itself ships no migration because the default is
no-op.
