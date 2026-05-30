# @reactorynet/workflow-es

[![CI](https://github.com/reactorynet/reactory-workflow-es/actions/workflows/ci.yml/badge.svg)](https://github.com/reactorynet/reactory-workflow-es/actions/workflows/ci.yml)

> **This is a Reactory-maintained fork of [`danielgerlag/workflow-es`](https://github.com/danielgerlag/workflow-es).**  
> The upstream project has not been updated since 2019 (v2.3.5). This fork modernises the
> codebase and adds features required by the [Reactory](https://github.com/reactorynet) platform.
> All credit for the original design and implementation goes to **Daniel Gerlag**.

---

A lightweight workflow / saga engine for Node.js. Supports pluggable persistence and
concurrency providers for multi-node clusters.

## Installing

This package is not published to npm independently — it is consumed by `reactory-express-server`
as a `file:` dependency built from source. The Reactory installer (`bin/install.sh`) handles
cloning this repo, building it, and wiring up the server dependency automatically.

If you are contributing to the workflow engine directly:

```bash
git clone https://github.com/reactorynet/reactory-workflow-es.git
cd reactory-workflow-es/core
yarn install
yarn build       # compile TypeScript → build/
yarn test        # run Jasmine test scenarios
yarn build:pack  # build + emit .tgz artifact for local integration
```

## What Changed from Upstream

### Bug Fixes

| Fix | Details |
|---|---|
| Node.js 22 compatibility | Removed `util.isNullOrUndefined` (removed in Node 22); replaced with an inline helper in `execution-result-processor.ts` |
| Error persistence | Step errors are now written to `pointer.persistenceData._errors[]` with message, stack, timestamp and retry count — not just `result.errors` |
| Instance-isolated state | `MemoryPersistenceProvider`, `SingleNodeLockProvider`, `SingleNodeQueueProvider`, and `WorkflowRegistry` all used module-level `var` arrays, causing state to leak between instances and corrupt test runs. All converted to instance `private` fields. |
| Secure ID generation | `generateUID()` and `generatePointerId()` previously used `Math.random()`, which is collision-prone. Both now use `crypto.randomUUID()`. |
| `acquireLock` typo | `IDistributedLockProvider.aquireLock` renamed to `acquireLock` throughout the interface, all implementations, and all call sites. |

### Modernisation

| Change | Details |
|---|---|
| Package name | `workflow-es` → `@reactorynet/workflow-es` |
| Version | `2.3.5` → `2.3.6-reactory.2` |
| TypeScript | `^2.2.1` → `^5.0.0` |
| TypeScript target | `ES5` → `ES2020` |
| `noImplicitAny` | Enabled (`true`); all implicit `any` types resolved |
| inversify | `^4.1.0` → `^6.0.0` |
| reflect-metadata | `^0.1.10` → `^0.2.0` |
| Jasmine | `^2.5.2` → `^5.0.0` |
| `QueueType` | Converted from a plain object to a TypeScript `enum` |
| CI | Travis CI replaced with GitHub Actions (Node 20 & 22 matrix) |
| Repository URL | Updated to `reactorynet/reactory-workflow-es` |

## Planned Improvements

- **Jest migration** — replace Jasmine with Jest to align with the rest of the Reactory platform
- **Strict mode** — enable full TypeScript `strict: true` (currently only `noImplicitAny`)
- **`ExecutionPointer` typing** — replace `persistenceData: any` with a typed interface
- **Reactory event integration** — emit Reactory Queue events on workflow lifecycle transitions (started, completed, failed, suspended)
- **Reactory service adapter** — wrap `WorkflowHost` as a `@reactorynet/reactory-core` `IReactoryService` so it participates in the IoC container and lifecycle of the express server
- **Dead-letter queue** — route permanently failed steps to a configurable dead-letter handler
- **OpenTelemetry instrumentation** — emit spans for step execution (integrate with `reactory-telemetry`)
- **Provider upgrades** — bring MongoDB, Redis and Azure providers up to current driver versions

## Guides (from upstream)

- [JavaScript (ES6)](es2017-guide.md)
- [TypeScript](typescript-guide.md)

## Persistence

- **MemoryPersistenceProvider** *(default — for development and testing only)*
- [MongoDB](providers/workflow-es-mongodb)
- *(more to come)*

## Multi-node Clusters

### Queue Providers
- **SingleNodeQueueProvider** *(default — single process only)*
- [Azure](providers/workflow-es-azure)
- [Redis](providers/workflow-es-redis)

### Distributed Lock Managers
- **SingleNodeLockProvider** *(default — single process only)*
- [Azure](providers/workflow-es-azure)
- [Redis Redlock](providers/workflow-es-redis)

## Authors

- **Daniel Gerlag** — original design and implementation
- **Reactory contributors** — fork maintenance and Reactory-specific extensions

## License

MIT — see [LICENSE.md](LICENSE.md)

