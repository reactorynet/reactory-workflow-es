# Spec — H6 · At-rest encryption/redaction hook for workflow data

| Field | Value |
|---|---|
| **Item ID** | H6 |
| **Title** | At-rest encryption/redaction hook for workflow data |
| **Plan reference** | [`upgrade-plan.md` → H6](../upgrade-plan.md) |
| **Target** | Cloud (additive; default no-op keeps Electron/dev plaintext) |
| **Severity** | High |
| **Owner tag** | `[claude]` |
| **Status** | spec |
| **Depends on** | C1 (`done`) — the `IPersistenceProvider` serialization boundary and concurrency token must be settled first |
| **Author / reviewer** | claude / wweber |

---

## 1. Context (self-contained)

`@reactorynet/workflow-es` persists two opaque, user-controlled payloads to whatever persistence
provider is configured:

- **`WorkflowInstance.data`** — `public data : any;` in
  `core/src/models/workflow-instance.ts:11`. This is the workflow's mutable state object, set by the
  caller at `host.startWorkflow(id, version, data)` (`core/src/services/workflow-host.ts:51-70`,
  assigned `wf.data = data` at line 58) and mutated by every step body.
- **`Event.eventData`** — `public eventData: any;` in `core/src/models/event.ts:5`. This is the
  payload supplied to `host.publishEvent(eventName, eventKey, eventData, eventTime)`
  (`core/src/services/workflow-host.ts:77-90`, assigned `evt.eventData = eventData` at line 84).

Today these payloads are written **verbatim** to the provider. There is no hook between "core has the
in-memory object" and "the provider stores it", so the bytes at rest are exactly the plaintext object:

- `MemoryPersistenceProvider` keeps the live object references in arrays
  (`core/src/services/memory-persistence-provider.ts:13` push instance, `:49` push event).
- `PostgresPersistence` writes `data: instance.data` straight into a `JSONB` column
  (`providers/workflow-es-postgres/src/postgres-provider.ts:64`; the column is declared
  `@Column(DataType.JSONB) data: any;` in `providers/workflow-es-postgres/src/models/workflow.ts:40-41`)
  and reads it back at `:179` (`instance.data = model.data;`). Events are written via
  `EventModel.create(event as any)` (`:125`) and read back at `:228` (`event.eventData = model.eventData;`).

Enterprise workflows routinely carry PII and secrets (account numbers, tokens, customer records) in
these payloads. Because there is no encryption/redaction seam:

1. Anyone with read access to the database (DBA, backup, replica, snapshot) sees plaintext PII/secrets.
2. There is no central place to size-guard a payload — an oversized `data` blob is accepted silently
   until the provider's column/driver fails deep inside `persistWorkflow`.
3. There is risk of plaintext leaking into logs (the verbatim object is the same object that other
   items, e.g. M4 structured logging, may serialize).

C1 deliberately left this seam open: C1's spec (`docs/specs/c1-distributed-providers.md:601`) states
*"The `data` round-trip is untouched (H6 owns serialization hooks). Do not add `json-stable-stringify`."*
H6 is that owner.

There is currently **no** serialization hook, no codec abstraction, and no DI symbol for one.

## 2. Goal

After this item, the engine has a single, provider-agnostic **`IDataCodec`** seam through which the two
opaque payloads (`WorkflowInstance.data` and `Event.eventData`) pass on the way to the persistence
provider (encode) and on the way back (decode). The default binding is a **no-op codec**, so desktop,
dev, and existing deployments behave exactly as today (plaintext, zero config). When an operator binds
an encrypting/redacting codec via `config.useDataCodec(...)`, the payloads are transformed before they
reach **any** provider and restored after they are read back — with no per-provider crypto code and no
change to provider source. Queryable fields (`eventName`, `eventKey`, `status`, `nextExecution`,
`eventTime`) are **never** passed through the codec and remain plaintext/indexable. An optional size
guard rejects oversized payloads at the same central seam with a clear error. The data-at-rest model
(codec seam + reliance on database TDE as the baseline) is documented.

## 3. Out of scope

- **Do NOT** implement any real cryptography. H6 ships only the **interface**, the **no-op default**,
  the **central wiring**, the **size guard**, and **docs**. A concrete AES/KMS codec is a separate
  downstream task (consumer-supplied). Tests use a *fake reversible* codec.
- **Do NOT** edit any provider source file to add encryption. The whole point is that providers are
  unaffected. The only provider-directory edits permitted are documentation (`README`) if needed.
- **Do NOT** encode/transform any field other than `WorkflowInstance.data` and `Event.eventData`.
  Specifically leave `eventName`, `eventKey`, `eventTime`, `status`, `nextExecution`,
  `workflowDefinitionId`, `version`, `id`, execution-pointer fields, and subscription fields untouched.
- **Do NOT** change the `IPersistenceProvider` interface, the concurrency token from C1, or any
  persisted column shape/schema. The codec output must still fit the existing `data`/`eventData`
  storage (it stays `any`/JSON-compatible — see §5).
- **Do NOT** change `WorkflowInstance.data`/`Event.eventData` *types* (they remain `any`).
- **Do NOT** add a per-step or per-field encryption DSL, schema validation, or key-rotation machinery.
  Those are future items; H6 only provides the seam they would plug into.
- **Do NOT** modify `EventSubscription` or execution-pointer persistence.

## 4. Files to create / modify

| Path | Action | Why |
|---|---|---|
| `core/src/abstractions/data-codec.ts` | create | Declares the `IDataCodec` interface and the `DataCodecContext` type. |
| `core/src/abstractions/types.ts` | modify | Add `IDataCodec: Symbol("IDataCodec")` DI symbol. |
| `core/src/abstractions.ts` | modify | Add `export * from "./abstractions/data-codec";` to the barrel. |
| `core/src/services/null-data-codec.ts` | create | The no-op default codec (`encode`/`decode` return the value unchanged). |
| `core/src/services/passphrase-size-guard.ts` | n/a | (not created — size guard lives inside the codec-application helper, see below) |
| `core/src/services/data-codec-runner.ts` | create | Central helper that applies the bound codec (+ optional size guard) to `instance.data` and `event.eventData` at the persistence boundary; exposes `encodeInstance`/`decodeInstance`/`encodeEvent`/`decodeEvent`. |
| `core/src/services.ts` | modify | Export `NullDataCodec` and `DataCodecRunner` from the services barrel. |
| `core/src/config.ts` | modify | Bind `IDataCodec` → `NullDataCodec` by default; add `useDataCodec(...)` and `useDataCodecSizeLimit(...)` to `WorkflowConfig`; bind `DataCodecRunner`. |
| `core/src/services/workflow-host.ts` | modify | Route `createNewWorkflow`/`publishEvent` writes and any direct reads through `DataCodecRunner` (encode before persist, decode after read). See §5/§7 for exact injection points. |
| `core/src/services/workflow-queue-worker.ts` | modify | Decode the instance `data` after `getWorkflowInstance`, encode before `persistWorkflow`. (Exact lines determined by reading the file; pattern in §7.) |
| `core/src/services/event-queue-worker.ts` | modify | Decode `eventData` after `getEvent` before it is handed to step input; instance decode/encode around `getWorkflowInstance`/`persistWorkflow`. |
| `core/src/services/poll-worker.ts` | modify | If it loads instances and re-persists, route through the runner (verify; if it only deals in ids, no change). |
| `docs/data-at-rest.md` | create | The documented data-at-rest model: codec seam, no-op default, TDE baseline, size guard, what is/isn't encrypted (query fields stay plaintext), worked example. |
| `core/spec/scenarios/data-codec.spec.ts` | create | The TDD scenario (failing-test-first + coverage) per §8. |
| `core/package.json` | modify | Version bump (see §10). |

> The implementer **must** open `core/src/services/workflow-queue-worker.ts`,
> `event-queue-worker.ts`, and `poll-worker.ts` and locate every call site of
> `getWorkflowInstance`, `persistWorkflow`, `createNewWorkflow`, `getEvent`, and `createEvent`. Those
> are the only call sites that touch the opaque payloads, and each must be wrapped exactly as §7
> describes. Do not guess line numbers — grep for the method names.

## 5. Interface & data-model changes

### 5.1 New abstraction: `IDataCodec`

The codec is **async** (`encode`/`decode` return `Promise`). Justification: real implementations call
KMS / HSM / envelope-encryption services that are network-bound and inherently async; the persistence
boundary is already fully `async` (every `IPersistenceProvider` method returns `Promise`), so awaiting
the codec adds no new color to the code. A sync interface would force a future real codec to either
block the event loop or break the contract.

```ts
// core/src/abstractions/data-codec.ts  (NEW FILE)

/**
 * Identifies which opaque payload is being transformed and the workflow it belongs to.
 * Passed to encode/decode so a codec MAY key/scope ciphertext (e.g. per workflow definition)
 * without the codec needing access to the whole instance. Purely advisory: a codec may ignore it.
 */
export interface DataCodecContext {
    /** "instance.data" | "event.data" — the logical slot being transformed. */
    kind: "instance.data" | "event.data";
    /** Workflow definition id, when known (instance.data path). Optional. */
    workflowDefinitionId?: string;
    /** Workflow definition version, when known. Optional. */
    version?: number;
    /** Event name, when known (event.data path). Optional. NEVER itself encoded. */
    eventName?: string;
}

/**
 * At-rest transform for the engine's two opaque payloads:
 *   - WorkflowInstance.data
 *   - Event.eventData
 *
 * `encode` is applied in core immediately before the value is handed to the persistence provider.
 * `decode` is applied in core immediately after the value is read back from the provider, before it
 * is exposed to step bodies / callers.
 *
 * Contract:
 *  - decode(encode(x)) must deep-equal x for any JSON-serialisable x (round-trip).
 *  - encode/decode MUST be idempotent at the boundary in the sense of §6.5: re-persisting an
 *    already-decoded instance and re-reading it yields the original value (encode is applied once
 *    per persist, decode once per read; the runner guarantees single application — see §7).
 *  - The returned value MUST be storable in the existing data/eventData slot (JSON-compatible:
 *    object | array | string | number | boolean | null). An encrypting codec therefore returns an
 *    envelope object, e.g. { __wfes_enc: 1, alg: "...", ct: "<base64>" }, NOT a raw Buffer.
 *  - encode/decode MUST NOT touch or depend on any other field (eventName/eventKey/status remain
 *    plaintext and queryable).
 */
export interface IDataCodec {
    encode(value: any, context: DataCodecContext): Promise<any>;
    decode(value: any, context: DataCodecContext): Promise<any>;
}
```

### 5.2 No-op default codec

```ts
// core/src/services/null-data-codec.ts  (NEW FILE)
import { injectable } from "inversify";
import { IDataCodec, DataCodecContext } from "../abstractions";

@injectable()
export class NullDataCodec implements IDataCodec {
    public async encode(value: any, _context: DataCodecContext): Promise<any> {
        return value;
    }
    public async decode(value: any, _context: DataCodecContext): Promise<any> {
        return value;
    }
}
```

### 5.3 Central application helper (`DataCodecRunner`) + size guard

The runner is the **single place** the codec is invoked. Workers/host call the runner, never the codec
directly. The optional size guard runs here, before `encode`, on the JSON byte length of the *plaintext*
payload (so the limit is meaningful regardless of ciphertext expansion).

```ts
// core/src/services/data-codec-runner.ts  (NEW FILE)
import { injectable, inject, optional } from "inversify";
import { TYPES, IDataCodec, DataCodecContext } from "../abstractions";
import { WorkflowInstance, Event } from "../models";

@injectable()
export class DataCodecRunner {
    @inject(TYPES.IDataCodec)
    private codec: IDataCodec;

    // 0 / undefined = no limit. Set via WorkflowConfig.useDataCodecSizeLimit(bytes).
    public maxPayloadBytes: number = 0;

    private guard(value: any, ctx: DataCodecContext): void {
        if (!this.maxPayloadBytes || value === undefined || value === null) return;
        const bytes = Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
        if (bytes > this.maxPayloadBytes) {
            throw new Error(
                `workflow-es: ${ctx.kind} payload of ${bytes} bytes exceeds configured limit of ` +
                `${this.maxPayloadBytes} bytes`
            );
        }
    }

    public async encodeInstance(instance: WorkflowInstance): Promise<void> {
        const ctx: DataCodecContext = {
            kind: "instance.data",
            workflowDefinitionId: instance.workflowDefinitionId,
            version: instance.version
        };
        this.guard(instance.data, ctx);
        instance.data = await this.codec.encode(instance.data, ctx);
    }

    public async decodeInstance(instance: WorkflowInstance): Promise<void> {
        if (!instance) return;
        const ctx: DataCodecContext = {
            kind: "instance.data",
            workflowDefinitionId: instance.workflowDefinitionId,
            version: instance.version
        };
        instance.data = await this.codec.decode(instance.data, ctx);
    }

    public async encodeEvent(event: Event): Promise<void> {
        const ctx: DataCodecContext = { kind: "event.data", eventName: event.eventName };
        this.guard(event.eventData, ctx);
        event.eventData = await this.codec.encode(event.eventData, ctx);
    }

    public async decodeEvent(event: Event): Promise<void> {
        if (!event) return;
        const ctx: DataCodecContext = { kind: "event.data", eventName: event.eventName };
        event.eventData = await this.codec.decode(event.eventData, ctx);
    }
}
```

### 5.4 DI / config impact

`core/src/abstractions/types.ts` — add one symbol:

```ts
// BEFORE
let TYPES = {
    IWorkflowRegistry: Symbol("IWorkflowRegistry"),
    // ...
    IExecutionPointerFactory: Symbol("IExecutionPointerFactory")
};

// AFTER
let TYPES = {
    IWorkflowRegistry: Symbol("IWorkflowRegistry"),
    // ...
    IExecutionPointerFactory: Symbol("IExecutionPointerFactory"),
    IDataCodec: Symbol("IDataCodec")
};
```

`core/src/config.ts` — bind the default, bind the runner, add two config methods:

```ts
// In configureWorkflow()'s ContainerModule, ALONGSIDE the existing binds:
bind<IDataCodec>(TYPES.IDataCodec).to(NullDataCodec).inSingletonScope();
bind<DataCodecRunner>(DataCodecRunner).toSelf().inSingletonScope();

// New methods on WorkflowConfig:
public useDataCodec(service: IDataCodec) {
    this.container.rebind<IDataCodec>(TYPES.IDataCodec).toConstantValue(service);
}

public useDataCodecSizeLimit(maxPayloadBytes: number) {
    this.container.get<DataCodecRunner>(DataCodecRunner).maxPayloadBytes = maxPayloadBytes;
}
```

Imports in `config.ts` must add `IDataCodec` (from `./abstractions`) and `NullDataCodec`,
`DataCodecRunner` (from `./services`). The `WorkflowHost`, `WorkflowQueueWorker`, `EventQueueWorker`,
and `PollWorker` get the `DataCodecRunner` injected via `@inject(DataCodecRunner)`.

### 5.5 How it composes with C1 serialization

C1 added the optimistic-concurrency token to `WorkflowInstance` and the `persistWorkflow` predicate but
**did not** transform `data`. The H6 codec runs *on the value of `data`/`eventData` only* and is
strictly inside the C1 boundary: encode happens after the worker has prepared the instance (including
C1's token bump) and immediately before `persistWorkflow`; decode happens immediately after
`getWorkflowInstance`/`getEvent` returns. The codec never reads or writes the concurrency token,
`status`, or `nextExecution`, so C1's last-write-wins guard and runnable queries are unaffected. Order
guarantee: **token bump (C1) → encode (H6) → persist** and **read → decode (H6) → execute**.

### 5.6 Persisted / at-rest format impact

No column/schema change. The codec output replaces the *contents* of the existing `data`/`eventData`
slot. With the default `NullDataCodec` the at-rest bytes are byte-identical to today (no migration). If
an operator later binds an encrypting codec, **previously stored plaintext rows are not retroactively
encrypted** and a real codec's `decode` must tolerate reading legacy plaintext (documented in
`docs/data-at-rest.md` as a consumer responsibility; H6 itself ships no migration because the default
is no-op).

## 6. Behavioural contract (numbered rules)

1. **At-rest transform when configured.** When a non-default `IDataCodec` is bound via
   `config.useDataCodec(...)`, the value written to the provider for `WorkflowInstance.data` and
   `Event.eventData` is the codec's `encode` output, not the original plaintext. (Test §8 asserts the
   persisted bytes are transformed.)
2. **Round-trip.** For any JSON-serialisable payload, the value observed by step bodies and by callers
   reading the instance/event equals the original input: `decode(encode(x))` deep-equals `x`. The
   workflow runs to completion and `instance.data` is the plaintext final state. (Test §8.)
3. **Query fields stay plaintext / queryable.** `eventName`, `eventKey`, `eventTime`, `status`,
   `nextExecution`, `workflowDefinitionId`, and `version` are NEVER passed to the codec and are stored
   unchanged. `getSubscriptions`, `getEvents`, `getRunnableInstances`, and `getRunnableEvents` continue
   to match on these plaintext fields with a codec configured. (Test §8 asserts `eventName` is
   plaintext and an event published with a codec still wakes its subscription.)
4. **No plaintext payload in logs.** Core MUST NOT log the raw `data`/`eventData` contents. The
   existing `publishEvent` log (`workflow-host.ts:80`) already logs only `eventName`/`eventKey` — keep
   it that way; do not add payload logging. Coordinate with M4 (structured logging): the correlation
   context may carry `workflowId`/`stepId` but MUST NOT include the payload object. (Reviewer greps for
   payload logging; no automated test.)
5. **Idempotency / single-application.** `encode` is applied exactly once per persist and `decode`
   exactly once per read, mediated by `DataCodecRunner` (§7). The runner never double-encodes: workers
   call `encodeInstance` immediately before `persistWorkflow` and never re-use the same in-memory
   instance for execution after encoding without decoding first. Re-persisting and re-reading an
   instance N times yields the original plaintext each time. (Test §8 persists/reads twice.)
6. **No-op default.** With no `useDataCodec` call, behaviour and at-rest bytes are identical to the
   pre-H6 engine; all existing scenarios in `core/spec/scenarios/` pass unchanged. (Existing suite.)
7. **Size guard (optional).** When `useDataCodecSizeLimit(n)` is set and a plaintext payload exceeds
   `n` bytes (UTF-8 JSON length), the persist/publish operation throws a clear error and does not write
   a partial/oversized row. When unset (default 0), no limit is enforced. (Test §8.)
8. **Codec failure surfaces.** If `encode`/`decode` rejects, the error propagates to the
   persist/read call site (it is not swallowed); the workflow is not silently marked complete with
   corrupt data.

## 7. Provider parity

**No core interface change; the codec is applied centrally in core, so no provider is modified.**

Confirmation by code inspection of where the opaque payloads cross the boundary:

- `WorkflowInstance.data` only ever crosses via `IPersistenceProvider.createNewWorkflow` /
  `persistWorkflow` (write) and `getWorkflowInstance` (read). In core these are called from
  `workflow-host.ts` (`createNewWorkflow` at `:66`; `persistWorkflow` at `:104`, `:132`, `:159`;
  `getWorkflowInstance` at `:101`, `:129`, `:157`) and from the workers
  (`workflow-queue-worker.ts`, `event-queue-worker.ts`, `poll-worker.ts`).
- `Event.eventData` only ever crosses via `createEvent` (write, `workflow-host.ts:88`) and `getEvent`
  (read, in `event-queue-worker.ts`).

Because every one of these call sites lives in **core**, wrapping them with `DataCodecRunner` makes the
transform universal. `MemoryPersistenceProvider`, `PostgresPersistence`, and the Mongo/MySQL/Redis/Azure
providers receive (write) and return (read) the already-encoded value and need **zero** changes — they
keep storing whatever is in the `data`/`eventData` slot, which is now opaque to them. This satisfies the
design constraint: a single, provider-agnostic boundary, no per-provider crypto code.

**Decision (core-boundary vs provider-side): core-boundary.** A provider-side hook would require
duplicating the encode/decode call in every provider (6+ providers, including the deprecated ones),
inviting drift and missed call sites, and would put crypto where provider authors must re-implement it.
The core boundary is exactly one set of call sites, all already `async`, all in one package — so the
codec is bound once and benefits every provider for free.

**Required wrapping pattern at each core call site** (the implementer applies this; the runner is
injected as `private codecRunner: DataCodecRunner`):

```ts
// WRITE (createNewWorkflow / persistWorkflow):
await this.codecRunner.encodeInstance(instance);   // mutates instance.data -> ciphertext
await this.persistence.persistWorkflow(instance);  // (or createNewWorkflow)
await this.codecRunner.decodeInstance(instance);   // restore plaintext if instance is reused in-process

// READ (getWorkflowInstance):
const instance = await this.persistence.getWorkflowInstance(id);
await this.codecRunner.decodeInstance(instance);   // instance.data -> plaintext before use

// EVENT WRITE (createEvent in publishEvent):
await this.codecRunner.encodeEvent(evt);
const id = await this.persistence.createEvent(evt);

// EVENT READ (getEvent):
const evt = await this.persistence.getEvent(id);
await this.codecRunner.decodeEvent(evt);
```

The post-write `decodeInstance` (restore) is required only where the same in-memory `instance` object
continues to be used after the persist in the same scope (e.g. it is returned or re-read by reference);
where the instance is discarded after persist, the restore may be omitted. The implementer must check
each call site. For `MemoryPersistenceProvider` specifically — which stores the *live object reference*,
not a copy — the restore is **mandatory** after every write, otherwise the next in-memory read would see
ciphertext. (This is the one subtlety the test in §8 is designed to catch.)

| Provider | Change required |
|---|---|
| memory | None (core wraps the boundary). |
| sqlite | None. |
| postgres | None. |
| mongodb | None. |
| mysql | None. |
| redis | None. |
| azure | None. |

## 8. Test plan (TDD)

New file `core/spec/scenarios/data-codec.spec.ts`, following the `external-events.spec.ts` pattern
(configure host with `MemoryPersistenceProvider`, `spinWait` for status change). A **fake reversible
codec** is used (no real crypto):

```ts
class FakeReversibleCodec implements IDataCodec {
    // marker so the test can assert the persisted value is transformed, and so
    // decode is verifiably the inverse.
    async encode(value: any) {
        if (value === undefined || value === null) return value;
        return { __fake_enc: true, payload: Buffer.from(JSON.stringify(value)).toString("base64") };
    }
    async decode(value: any) {
        if (value && value.__fake_enc) return JSON.parse(Buffer.from(value.payload, "base64").toString("utf8"));
        return value; // tolerate legacy plaintext
    }
}
```

### Failing-test-first
- **`persisted instance.data is transformed at rest`** — arrange: a one-step workflow whose step sets
  `data.secret = "topsecret"`; configure host with `MemoryPersistenceProvider` and
  `config.useDataCodec(new FakeReversibleCodec())`. act: start the workflow, `spinWait` until status is
  not Runnable, then **reach into the live persistence store** for the stored instance reference (the
  same object memory keeps) and inspect `instance.data`. assert: the stored `data` is the envelope
  (`__fake_enc === true`), i.e. NOT the plaintext `{ secret: "topsecret" }`. **This fails before the
  fix** because today the live plaintext object is stored unchanged (proves §6.1 + the memory-restore
  subtlety in §7).

### Coverage
- **`data round-trips to plaintext for callers`** — after completion, `host`-side
  `getWorkflowInstance(workflowId)` (which goes through the decode wrap) returns `data.secret ===
  "topsecret"`. Proves §6.2.
- **`eventName/eventKey stay plaintext and still wake subscriptions`** — a `waitFor` workflow + codec
  configured; `publishEvent("my-event","0", { token: "abc" }, ...)`. Assert: the subscription is found
  by `getSubscriptions("my-event","0",...)` (eventName/eventKey matched as plaintext), the workflow
  resumes, and the step sees decoded `eventData.token === "abc"`. Inspect the stored event in the
  memory store: `event.eventName === "my-event"` (plaintext) while `event.eventData.__fake_enc ===
  true`. Proves §6.3.
- **`no-op default leaves data untouched`** — same workflow, NO `useDataCodec`; stored `instance.data`
  is the plaintext object. Proves §6.6 (and the whole existing suite passing is the broader proof).
- **`idempotent across repeated persist/read`** — load the completed instance via the host wrap twice;
  both reads return plaintext `secret === "topsecret"` (decode not double-applied; encode not
  double-applied on the in-memory object). Proves §6.5.
- **`size guard rejects oversized payload`** — `config.useDataCodecSizeLimit(50)`; start a workflow
  whose `data` JSON exceeds 50 bytes. Assert the start/persist path throws an error containing
  `"exceeds configured limit"` and the workflow is not left in a written-but-corrupt state. Proves
  §6.7.
- **`codec failure propagates`** — bind a codec whose `encode` throws; assert the error surfaces (the
  instance does not silently complete). Proves §6.8.

> **Postgres integration variant (note, owned by M8):** the same `persisted ... transformed at rest`
> assertion should be re-run against `PostgresPersistence` under the M8 Testcontainers harness — query
> the raw `JSONB` `data` column with SQL and assert it holds the envelope, not the plaintext, while a
> `SELECT ... WHERE "eventName" = 'my-event'` still matches. This is documented here but implemented
> under M8; do not add a postgres dependency to the core test suite.

### How to run
```bash
cd core && yarn build
cd core && yarn test            # runs data-codec.spec.ts + existing scenarios
# Postgres integration variant runs under M8's CI matrix (Testcontainers), not in core.
```

## 9. Acceptance criteria (binary)

- [ ] `cd core && yarn build` succeeds.
- [ ] `cd core && yarn test` passes on Node 20 and 22 (new + existing scenarios).
- [ ] With `FakeReversibleCodec` bound, the stored `instance.data` and `event.eventData` are the
      envelope object, not plaintext (test `persisted instance.data is transformed at rest`).
- [ ] With the codec bound, the workflow runs to completion and `getWorkflowInstance(...).data` is the
      original plaintext (round-trip test).
- [ ] With the codec bound, an event published by name/key still wakes its subscription and the step
      sees decoded `eventData` (query-field test).
- [ ] With no `useDataCodec`, at-rest `data` is byte-identical to pre-H6 (no-op default test) and the
      full pre-existing scenario suite passes.
- [ ] `useDataCodecSizeLimit(n)` causes an oversized payload to throw `"exceeds configured limit"`.
- [ ] `grep` shows no core call site logs raw `data`/`eventData`.
- [ ] `docs/data-at-rest.md` exists and documents: the codec seam, no-op default, what is/ isn't
      encoded (query fields excluded), TDE baseline reliance, size guard, and the legacy-plaintext
      decode caveat.
- [ ] No provider source file (other than docs) is modified.

## 10. Backward compatibility & migration

Public API is **additive**: new `IDataCodec` abstraction, `TYPES.IDataCodec`, `NullDataCodec`,
`DataCodecRunner`, and `WorkflowConfig.useDataCodec` / `useDataCodecSizeLimit`. No existing signature
changes. The default binding is no-op, so the at-rest format is unchanged and there is **no migration**
for existing consumers (`reactory-express-server` keeps working with zero code changes). A consumer that
*opts in* to an encrypting codec is responsible for handling pre-existing plaintext rows (their codec's
`decode` should tolerate legacy plaintext — documented in `docs/data-at-rest.md`). Version bump:
following C1's convention (`2.4.0-reactory.0` after C1), H6 is an additive minor →
**`2.4.0-reactory.N` → next `2.5.0-reactory.0`** (or the next free `-reactory.N` if it lands as a patch
on the same minor; reviewer picks per release state). Record the chosen value in `core/package.json`.

## 11. Definition of Done

The engine exposes a single provider-agnostic `IDataCodec` seam, bound by default to a no-op so desktop
and existing deployments are byte-for-byte unchanged and require no migration. When an operator binds an
encrypting/redacting codec, `WorkflowInstance.data` and `Event.eventData` are transformed by core
immediately before they reach any persistence provider and restored immediately after they are read
back — with no provider source modified — while `eventName`, `eventKey`, `status`, and the other query
fields remain plaintext and queryable. An optional size guard rejects oversized payloads at the same
central seam. The behaviour is proven by `core/spec/scenarios/data-codec.spec.ts` (transform-at-rest,
round-trip, query-field-plaintext, no-op default, idempotency, size guard, failure propagation) and the
data-at-rest model is documented in `docs/data-at-rest.md`. Reviewer confirms §9 checkboxes.

## 12. Implementation notes (optional, non-binding)

- Suggested edit order: (1) `data-codec.ts` + `types.ts` + barrel; (2) `null-data-codec.ts` +
  `data-codec-runner.ts` + `services.ts`; (3) `config.ts` binds + methods; (4) inject the runner into
  host/workers and wrap the call sites per §7; (5) write the spec test; (6) docs; (7) version bump.
- The memory-provider "stores the live reference" behaviour (`memory-persistence-provider.ts:13,49`) is
  the trap: without the post-write `decodeInstance`/the codec returning a fresh object, the in-memory
  store and the live instance share identity and you can both "encode in place" and accidentally read
  ciphertext on the next access. The failing-first test is built around exactly this. Returning a new
  envelope object from `encode` (as `FakeReversibleCodec` does) plus a mandatory restore after memory
  writes is the safe pattern.
- Upstream `danielgerlag/workflow-es` has no equivalent; this seam is a Reactory addition. Keep the
  interface minimal so a future per-field redaction policy or KMS envelope codec can implement it
  without an interface change.
- Do not introduce `json-stable-stringify` or any canonicalisation here (C1 explicitly forbade it for
  the `data` round-trip); the size guard's `JSON.stringify` is only for byte-length measurement, not
  for storage.
