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
up at execution time. **Never unregister an old workflow version while instances created against it
may still be running.** When you bump a workflow's `version`, keep registering all historical
versions on every host. For example:

```ts
host.registerWorkflow(MyWorkflow_v1); // version: 1 — keep registering while any v1 instances remain
host.registerWorkflow(MyWorkflow_v2); // version: 2 — the new version
```

If a host loads an instance whose version is not registered, the engine dead-letters that instance
(terminal `WorkflowStatus.DeadLettered`) and emits a `workflow.dead-lettered` lifecycle event naming
the missing `(definitionId, version)` — it does **not** retry, and there is no automatic recovery.
The error message instructs the operator to register all historical workflow versions.

Subscribe to lifecycle events to be notified when this occurs:

```ts
config.onLifecycleEvent(evt => {
    if (evt.event === "workflow.dead-lettered") {
        console.error("Dead-lettered:", evt.workflowDefinitionId, "v" + evt.version, evt.errorMessage);
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


