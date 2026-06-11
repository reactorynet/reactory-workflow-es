# Delegation & Model-Selection Guide

How spec items from [`upgrade-plan.md`](./upgrade-plan.md) are delegated to a Claude subagent, and
**which model each item gets**. The principle: match the model to the *intrinsic difficulty that
survives the spec*. The specs are deliberately detailed, so most work runs on `sonnet`; the expensive
tiers are reserved for items where correctness is hard even with a perfect spec.

All implementation work happens on the **`feat/upgrade`** branch.

---

## 1. Model ladder

| Tier (`model`) | Use for | Signals |
|---|---|---|
| `haiku` | Mechanical, low-judgement edits | package.json / import renames, pure config, no logic |
| `sonnet` | **Default.** Well-specified implementation, moderate complexity | clear spec, localized logic, follows an existing pattern |
| `fable` | **High complexity** | concurrency correctness, cross-cutting interface change across providers, new abstractions/design, security-sensitive |
| `opus` | **Highly complex only** | distributed/multi-node correctness where a subtle bug corrupts state and is hard to test |

Rules (from the request):
- **Do not use `opus` unless the task is *highly* complex.** Today exactly one item qualifies: **C1**.
- **Use `fable` only for *high*-complexity** items (the concurrency / cross-cutting / security set).
- **Everything else defaults to `sonnet`;** drop to `haiku` only when there is no real logic.
- **Escalation:** if a `sonnet`/`fable` attempt fails review twice on correctness (not on spec gaps),
  re-delegate one tier up and note why in the PR. Never silently retry at the same tier.
- **De-escalation:** if a `fable` item turns out to be mostly mechanical once its dependency landed,
  drop it to `sonnet`.

---

## 2. Per-item model assignment

Ordered by the roadmap. "Why this tier" is the deciding factor, not a full summary.

| # | ID | Item | Owner tag | **Model** | Why this tier |
|---|----|------|-----------|-----------|---------------|
| 1 | C1 | Distributed lock+queue providers; optimistic concurrency | `[claude]` | **`opus`** | Multi-node correctness: compare-and-set, all-provider ripple, two-host duplicate-execution test. The one *highly* complex item. |
| 2 | H2 | Close lock-release race | `[claude]` | **`fable`** | Concurrency correctness; reordering + idempotency where a wrong move reintroduces double-execution. |
| 3 | H3 | Lease/lock the poll worker | `[claude]` | **`sonnet`** | Uses the existing lock interface; lease + config plumbing; well-bounded. |
| 4 | H4 | Async graceful drain; SIGTERM + Electron quit | `[claude]` | **`fable`** | Await-in-flight + timeout + signal lifecycle + interface ripple to all workers; subtle to get right. |
| 5 | H1 | Bounded concurrency / backpressure | `[claude]` | **`fable`** | Worker-pool + backpressure + the in-flight set H4 reuses; concurrency correctness. |
| 6 | C2 | Embedded SQLite/file persistence provider | `[claude]` | **`sonnet`** | Large but mirrors the Postgres provider closely; spec is prescriptive. |
| 7 | H5 | Dead-letter + configurable max retries | `[claude]` | **`fable`** | Touches the error-strategy core; must not regress saga/compensation; new status + hub. |
| 8 | C3 | Repair Mongo / deprecate MySQL | `[copilot+review]` | **`sonnet`** | Mechanical callback→async translation + deprecation; needs the concurrency token + conformance, so above `haiku`. |
| 9 | M7 | Provider dependency hygiene | `[copilot+review]` | **`haiku`** | Pure package.json peer-dep moves + import renames; no logic. |
| 10 | M8 | Providers built + integration-tested in CI | `[copilot+review]` | **`sonnet`** | CI YAML + a shared conformance test module; moderate, pattern-driven. |
| 11 | M5 | OpenTelemetry tracing + metrics + health | `[claude]` | **`fable`** | New optional abstractions, adapter package, health aggregation; design-heavy. |
| 12 | M4 | Structured logging + correlation IDs | `[copilot+review]` | **`sonnet`** | Interface redesign + mechanical migration of ~27 call sites; public API but low algorithmic risk. |
| 13 | H6 | At-rest encryption/redaction hook | `[claude]` | **`fable`** | Security-sensitive; must not encode query fields; memory-provider live-reference trap. |
| 14 | M6 | Multi-tenancy / namespace scoping | `[claude]` | **`fable`** | Interface change across **all** providers + lock-key namespacing + default-tenant back-compat. |
| 15 | M2 | Mandated provider indexes | `[copilot+review]` | **`sonnet`** | Index definitions per provider + EXPLAIN verification; pattern-driven. |
| 16 | M1 | Workflow-definition version-safety | `[copilot+review]` | **`sonnet`** | Small; reuses H5's dead-letter machinery; `tryGetDefinition` + load-path guard. |
| 17 | M3 | Document & guard execution model (Electron) | `[claude]` | **`sonnet`** | Docs + an Electron sample; judgement in prose/sample, low core risk. |

**Tally:** `opus` ×1 · `fable` ×6 · `sonnet` ×9 · `haiku` ×1.

> The `fable` set is exactly the concurrency / cross-cutting / security-sensitive items
> (H2, H4, H1, H5, M5, H6, M6). If any proves more mechanical than expected once its dependency lands,
> de-escalate to `sonnet` per §1.

---

## 3. Invocation

Delegate one item per Agent call. The agent implements on `feat/upgrade`, runs the build+tests, and
reports back — its final message is the tool result (it is **not** shown to the user, so relay what
matters).

### 3.1 Reusable prompt template

Fill the four `<…>` slots. Keep the rest verbatim — it encodes the non-negotiables every item shares.

```
You are implementing ONE item from the @reactorynet/workflow-es enterprise upgrade plan.

REPO ROOT: /Users/wweber/Source/reactory/reactory-workflow-es
BRANCH: feat/upgrade  — confirm you are on it (`git rev-parse --abbrev-ref HEAD`); if not, `git switch feat/upgrade`. Do NOT commit or push unless asked; leave changes in the working tree.

ITEM: <ID> — <title>
SPEC: docs/specs/<id>-<slug>.md  ← this is your contract. Implement it exactly.

BEFORE CODING, READ (in order):
1. docs/specs/<id>-<slug>.md            (the full spec — §6 rules and §9 acceptance are binding)
2. docs/upgrade-plan.md §8              (AUTHORITATIVE cross-cutting conventions — overrides the spec on config surface, shared primitives, versioning, and ground-truth facts)
3. Verify every item in the spec's "Depends on" is already merged on feat/upgrade. If a dependency is missing, STOP and report — do not stub it.

IMPLEMENT (TDD):
- Write the failing-first test from the spec's §8 BEFORE the implementation; confirm it fails.
- Implement to satisfy §6's numbered rules. Edit only core/src/** (never core/build/**) and the files the spec's §4 lists.
- Honour §8 of the plan: scalar tunables go in WorkflowOptions (TYPES.WorkflowOptions); swappable services use WorkflowConfig.useX() setters; do NOT hard-code a version number; use the `spinWait` helper; barrels are flat files (core/src/models.ts etc.).
- If the spec changes a core interface, update ALL providers it lists in §7 in the same change.

VERIFY:
- cd core && yarn build && yarn test   (must pass on the installed Node; report the output)
- Run any provider/integration step the spec names.

REPORT BACK (your final message):
- Files changed; the failing-first test name and that it now passes; full test summary.
- Any deviation from the spec or §8, with justification.
- Anything a reviewer must check by hand. Do NOT claim done if tests fail — say so with the output.

CONSTRAINTS: Implement only this item. No scope creep into other items. No new dependencies beyond what the spec authorises.
```

### 3.2 Concrete examples

**Highly complex → `opus` (C1):**

```
Agent(
  subagent_type: "general-purpose",
  model: "opus",
  description: "Implement C1 distributed providers",
  prompt: <template with ID=C1, title="Distributed lock+queue + optimistic concurrency",
           spec="docs/specs/c1-distributed-providers.md">
)
```

**High complexity → `fable` (H4):**

```
Agent(
  subagent_type: "general-purpose",
  model: "fable",
  description: "Implement H4 graceful shutdown",
  prompt: <template with ID=H4, spec="docs/specs/h4-graceful-shutdown.md">
)
```

**Default → `sonnet` (C2):**

```
Agent(
  subagent_type: "general-purpose",
  model: "sonnet",
  description: "Implement C2 sqlite provider",
  prompt: <template with ID=C2, spec="docs/specs/c2-embedded-persistence.md">
)
```

**Mechanical → `haiku` (M7):**

```
Agent(
  subagent_type: "general-purpose",
  model: "haiku",
  description: "Implement M7 provider deps",
  prompt: <template with ID=M7, spec="docs/specs/m7-provider-deps.md">
)
```

---

## 4. Sequencing & parallelism

- **Respect `Depends on`** ([plan §8.5](./upgrade-plan.md#85-dependency-ordering-recap-of-the-cross-spec-graph)).
  `C1` is the root; do not start `C2/C3/M8/H6/M6` until it is merged. `H5` precedes `M1`. `M7` precedes `M8`.
- Items with **no shared files and no dependency edge** can be delegated in parallel — give each agent
  `isolation: "worktree"` so their working trees don't collide, then merge the worktrees in sequence.
  Good early parallel pair: **M7** (`haiku`) and **M3** docs (`sonnet`) — disjoint files, no code dep.
- Everything in **Phase 0** is on the critical path and touches overlapping concurrency code — run
  these **sequentially** (C1 → H2 → H3 → H4 → H1), not in parallel.

## 5. After an item returns

1. Relay the agent's report (files, tests, deviations) — the user did not see it.
2. Review against the spec's §9 acceptance criteria and plan §8 conventions.
3. On pass: flip the item's Status in [`upgrade-plan.md`](./upgrade-plan.md) §3 `spec → done`, and bump
   the core version per plan §8.3 (only at merge time, never inside the diff).
4. On fail for a correctness reason: escalate one model tier (§1) and re-delegate with the review notes
   appended to the prompt.
