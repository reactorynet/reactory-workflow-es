# Azure providers for Workflow ES

Provides distributed lock management and queue services on [Workflow ES](https://github.com/danielgerlag/workflow-es) using Azure Storage.

> **Package renamed.** As of `2.4.0-reactory.0` this package is published as
> `@reactorynet/workflow-es-azure` (was `workflow-es-azure`) and targets the
> `@reactorynet/workflow-es` core. The core libs (`@reactorynet/workflow-es`,
> `inversify`, `reflect-metadata`) are now peer dependencies.

## Installing

Install the npm package "@reactorynet/workflow-es-azure"

```
> npm install @reactorynet/workflow-es-azure --save
```

## Usage

Use the .useLockManager() and .useQueueManager() methods when setting up your workflow host.

```javascript
const workflow_es = require("workflow-es");
const workflow_azure = require("workflow-es-azure");
...
var config = workflow_es.configureWorkflow();
config.useLockManager(new workflow_azure.AzureLockManager('Azure storage connection string'));   
config.useQueueManager(new workflow_azure.AzureQueueProvider('Azure storage connection string'));

var host = config.getHost();
...
await host.start();
```
