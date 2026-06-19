> **DEPRECATED** — This package (`workflow-es-mysql`) is no longer maintained.
> MySQL support is available through [`@reactorynet/workflow-es-postgres`](../workflow-es-postgres)
> which is built on Sequelize 6 and supports multiple SQL dialects including MySQL.
>
> **Migration:** replace `MySqlPersistence` with `PostgresPersistence` and pass
> `{ dialect: "mysql" }` as the second argument. Install `mysql2` as your MySQL driver.
>
> ```typescript
> import { PostgresPersistence } from "@reactorynet/workflow-es-postgres";
>
> // Install: npm install @reactorynet/workflow-es-postgres mysql2
> const persistence = new PostgresPersistence(
>     "mysql://user:password@localhost:3306/workflow",
>     { dialect: "mysql" }
> );
> await persistence.connect;
> ```
>
> See [`providers/workflow-es-postgres/README.md`](../workflow-es-postgres/README.md)
> for full documentation including the "Using MySQL" section.
>
> **Why deprecated?** This standalone package used EOL dependencies (`sequelize@^4`,
> `sequelize-typescript@^0.6`). The Postgres provider (Sequelize 6) is multi-dialect
> and covers MySQL with no extra code — maintaining two near-identical providers was
> pure duplication.

---

# MySQL Persistence provider for Workflow ES (DEPRECATED)

Provides support to persist workflows running on [Workflow ES](https://github.com/danielgerlag/workflow-es) to a MySQL database.

> This package is deprecated. See the deprecation banner above for the migration path.

## Archived usage

```javascript
const workflow_es = require("workflow-es");
const workflow_mysql = require("workflow-es-mysql");
...
var config = workflow_es.configureWorkflow();
let mySqlPersistence = new workflow_mysql.MySqlPersistence("mysql://root:password@localhost:port/workflow-node");
await mySqlPersistence.connect;
config.usePersistence(mySqlPersistence);
var host = config.getHost();
...
await host.start();
```
