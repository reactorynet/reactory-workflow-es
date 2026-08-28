# Workflow ES 

[![Build Status](https://travis-ci.org/danielgerlag/workflow-es.svg?branch=master)](https://travis-ci.org/danielgerlag/workflow-es)

Workflow ES is a workflow / saga library for Node.js (or modern browsers).  It supports pluggable persistence and concurrency providers to allow for multi-node clusters.

## Installing

Install the core npm package "workflow-es"

```
npm install workflow-es --save
```


### Guides

* [Javascript (ES6)](https://github.com/danielgerlag/workflow-es/blob/master/es2017-guide.md)
* [Typescript](https://github.com/danielgerlag/workflow-es/blob/master/typescript-guide.md)


### Persistence

Since workflows are typically long running processes, they will need to be persisted to storage between steps.
There are several persistence providers available as seperate npm packages.

* Memory Persistence Provider *(Default provider, for demo and testing purposes)*
* [MongoDB](https://github.com/danielgerlag/workflow-es/tree/master/providers/workflow-es-mongodb)
* *(more to come soon...)*

## Workflow versioning & deploys

Workflow *definitions* are held in an in-memory registry, keyed by `(id, version)`; they are not
persisted. In-flight instances store only `(workflowDefinitionId, version)` and look the definition
up at execution time.

### `version` is a string, matched exactly

Since **3.0.0**, `version` is a semantic-version **string** (`"1.2.0"`), not a number.

It is compared by **exact string equality**. The engine never parses it, never orders it, and never
range-matches it — `"^1.2.0"` and `"1.2"` do not resolve a registered `"1.2.0"`. Range resolution at
load time would let an in-flight instance resume against a graph it was not started on, which is
precisely what the dead-letter protections below exist to prevent. If you want ranges, resolve them
in your own code *before* calling `startWorkflow`, and pass the exact version you resolved.

Because nothing is parsed, the string need not be semver at all — a date stamp or a git sha works
identically. The only requirement is that it is stable and exactly comparable.

### Never unregister an old version

**Never unregister an old workflow version while instances created against it may still be
running.** When you bump a workflow's `version`, keep registering all historical versions on every
host:

```ts
host.registerWorkflow(MyWorkflow_v1_0_0); // "1.0.0" — keep registering while any 1.0.0 instances remain
host.registerWorkflow(MyWorkflow_v1_1_0); // "1.1.0" — the new version
```

If a host loads an instance whose version is not registered, the engine dead-letters that instance
(terminal `WorkflowStatus.DeadLettered`) and emits a `workflow.dead-lettered` lifecycle event with
`reason: "definition-not-registered"` naming the missing `(definitionId, version)` — it does **not**
retry, and there is no automatic recovery. The error message instructs the operator to register all
historical workflow versions.

### Never edit a version in place

Bumping the version is not optional housekeeping. Execution pointers reference steps by **ordinal
index**, so editing a definition's graph without bumping its version would silently remap every
suspended pointer — an instance waiting at step 4 would resume into whatever step now sits at index
4.

The engine detects this. Each definition is fingerprinted at registration, the fingerprint is
stamped onto the instance at start, and it is re-checked on every load; a mismatch dead-letters the
instance with `reason: "definition-changed"` rather than executing it against a graph it did not
start on. Instances created before fingerprinting existed carry none and are exempt.

Set `definitionFingerprintMode` to relax this during a rollout:

```ts
configureWorkflow({ definitionFingerprintMode: "warn" }); // "enforce" (default) | "warn" | "off"
```

For definitions generated from an external source (a YAML file, a database row), set
`fingerprintSeed` on the workflow to a digest of that source. The structural fingerprint covers graph
shape only; step *configuration* usually lives in closures it cannot see, and the seed closes that
gap. Derive it from the source text — never from a timestamp or file mtime, or every restart will
invalidate every running instance.

Subscribe to lifecycle events to be notified when this occurs:

```ts
config.onLifecycleEvent(evt => {
    if (evt.event === "workflow.dead-lettered") {
        console.error("Dead-lettered:", evt.workflowDefinitionId, "v" + evt.version, evt.reason, evt.errorMessage);
    }
});
```

### Multi-node clusters

By default, the WorkflowHost service will run as a single node using the built-in queue and locking providers for a single node configuration.  Should you wish to run a multi-node cluster, you will need to configure an external queueing mechanism and a distributed lock manager to co-ordinate the cluster.  These are the providers that are currently available.

#### Queue Providers

* SingleNodeQueueProvider *(Default built-in provider)*
* [Azure](https://github.com/danielgerlag/workflow-es/tree/master/providers/workflow-es-azure)
* [Redis](https://github.com/danielgerlag/workflow-es/tree/master/providers/workflow-es-redis)


#### Distributed lock managers

* SingleNodeLockProvider *(Default built-in provider)*
* [Azure](https://github.com/danielgerlag/workflow-es/tree/master/providers/workflow-es-azure)
* [Redis Redlock](https://github.com/danielgerlag/workflow-es/tree/master/providers/workflow-es-redis)


## Authors

* **Daniel Gerlag** - *Initial work*


## License

This project is licensed under the MIT License - see the [LICENSE.md](https://github.com/danielgerlag/workflow-es/blob/master/LICENSE.md) file for details


