# Redis providers for Workflow ES

Provides distributed lock management and queue services on [Workflow ES](https://github.com/danielgerlag/workflow-es) using Redis.

> **Package renamed.** As of `2.4.0-reactory.0` this package is published as
> `@reactorynet/workflow-es-redis` (was `workflow-es-redis`). It targets the
> `@reactorynet/workflow-es` core, `ioredis` v5, and `redlock` v5. The core libs
> (`@reactorynet/workflow-es`, `inversify`, `reflect-metadata`) are now peer
> dependencies — install them alongside this provider.

## Installing

Install the npm package "@reactorynet/workflow-es-redis"

```
> npm install @reactorynet/workflow-es-redis --save
```

## Usage

Use the .useLockManager() and .useQueueManager() methods when setting up your workflow host.

```javascript
const workflow_redis = require("workflow-es-redis");
const Redis = require('ioredis');
...

let connection = new Redis('redis://:authpassword@127.0.0.1:6380/4');

var config = workflow_es.configureWorkflow();
config.useLockManager(new workflow_redis.RedisLockManager(connection));
config.useQueueManager(new workflow_redis.RedisQueueProvider(connection));

```
