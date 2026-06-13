# @reactorynet/workflow-es-opentelemetry

Optional [OpenTelemetry](https://opentelemetry.io/) metrics + tracing adapter for
[`@reactorynet/workflow-es`](../../core).

The core engine ships with no-op metrics/tracing by default and **no OpenTelemetry
dependency**. This package adapts the core `IMetrics` / `ITracer` facades onto
`@opentelemetry/api`, and is injected via the existing `WorkflowConfig` setters.

## Install

`@opentelemetry/api` and `@reactorynet/workflow-es` are **peer dependencies** — the
consumer supplies them (along with an OpenTelemetry SDK + exporter of their choosing):

```bash
npm install @reactorynet/workflow-es-opentelemetry @opentelemetry/api
# plus your SDK, e.g. @opentelemetry/sdk-node + an exporter
```

This package does **not** depend on any `@opentelemetry/sdk-*` package — only on the
stable, SDK-agnostic `@opentelemetry/api` facade. You wire up the SDK/exporter in your
application as usual.

## Usage

```ts
import { configureWorkflow } from "@reactorynet/workflow-es";
import { OpenTelemetryMetrics, OpenTelemetryTracer } from "@reactorynet/workflow-es-opentelemetry";

const config = configureWorkflow();
config.useMetrics(new OpenTelemetryMetrics());
config.useTracer(new OpenTelemetryTracer());

const host = config.getHost();
await host.start();
```

After this, the engine emits:

- a `workflowes.step.execute` span around every step body, carrying `workflow.id`,
  `workflow.step.id`, `workflow.definition.id`, `workflow.version`, and
  `workflow.step.name` attributes;
- metrics: `workflowes.workflow.started` / `workflowes.workflow.active` /
  `workflowes.step.duration` (ms) / `workflowes.step.errors` /
  `workflowes.step.retries` / `workflowes.event.published` /
  `workflowes.queue.depth`.

Both adapters swallow their own errors internally: a failing metrics/tracing backend
never breaks workflow execution.

## Health

`host.health()` lives in core and needs no OpenTelemetry — expose it from your
HTTP/readiness layer as you see fit.
