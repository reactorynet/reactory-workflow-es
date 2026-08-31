#!/usr/bin/env bash
# ==============================================================================
# Reactory Workflow Engine — M11 Migration Wrapper Script
#
# Automates execution of the M11 Version-to-Semver migration (integer -> semver string).
# Automatically extracts connection parameters from reactory-express-server/.env
# or accepts override CLI options.
#
# Defaults to --dry-run for safety. Pass --apply to actually commit changes.
#
# Usage:
#   ./run-m11-migration.sh [--store mongo|sqlite|postgres] [--apply] [--repair-from-id] [--env-file <path>]
#
# Examples:
#   # Dry run against default MongoDB using reactory-express-server/.env
#   ./run-m11-migration.sh
#
#   # Apply migration to MongoDB
#   ./run-m11-migration.sh --store mongo --apply
#
#   # Dry run against SQLite database
#   ./run-m11-migration.sh --store sqlite --path /path/to/workflow.db
# ==============================================================================

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKFLOW_ES_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
REACTORY_ROOT="$(cd "${WORKFLOW_ES_ROOT}/.." && pwd)"
DEFAULT_ENV_FILE="${REACTORY_ROOT}/reactory-express-server/.env"

STORE="mongo"
APPLY=0
REPAIR_FROM_ID=0
ENV_FILE="${DEFAULT_ENV_FILE}"
CUSTOM_URL=""
CUSTOM_PATH=""
COLLECTION=""
TABLE=""
QUIET=0

# Parse command line arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --store=*)
      STORE="${1#*=}"
      shift
      ;;
    --store)
      STORE="$2"
      shift 2
      ;;
    --apply)
      APPLY=1
      shift
      ;;
    --dry-run)
      APPLY=0
      shift
      ;;
    --repair-from-id)
      REPAIR_FROM_ID=1
      shift
      ;;
    --env-file=*)
      ENV_FILE="${1#*=}"
      shift
      ;;
    --env-file)
      ENV_FILE="$2"
      shift 2
      ;;
    --url=*)
      CUSTOM_URL="${1#*=}"
      shift
      ;;
    --url)
      CUSTOM_URL="$2"
      shift 2
      ;;
    --path=*)
      CUSTOM_PATH="${1#*=}"
      shift
      ;;
    --path)
      CUSTOM_PATH="$2"
      shift 2
      ;;
    --collection=*)
      COLLECTION="${1#*=}"
      shift
      ;;
    --table=*)
      TABLE="${1#*=}"
      shift
      ;;
    --quiet)
      QUIET=1
      shift
      ;;
    -h|--help)
      echo "Reactory M11 Migration Wrapper"
      echo "Usage: $0 [--store mongo|sqlite|postgres] [--apply] [--repair-from-id] [--env-file <path>] [--url <url>] [--path <path>]"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      echo "Use --help for usage information."
      exit 1
      ;;
  esac
done

# Load environment variables if env file exists
if [[ -f "${ENV_FILE}" ]]; then
  echo "--> Reading environment configuration from: ${ENV_FILE}"
  # Export non-comment lines
  set -a
  source <(grep -v '^#' "${ENV_FILE}" | grep -v '^\s*$') || true
  set +a
fi

MIGRATION_SCRIPT="${SCRIPT_DIR}/m11-version-to-semver.mjs"
CMD_ARGS=("--store=${STORE}")

if [[ ${APPLY} -eq 0 ]]; then
  CMD_ARGS+=("--dry-run")
  echo "--> Running in DRY-RUN mode (no changes will be written). Pass --apply to commit."
else
  echo "--> WARNING: Running in APPLY mode. Database will be updated."
fi

if [[ ${REPAIR_FROM_ID} -eq 1 ]]; then
  CMD_ARGS+=("--repair-from-id")
  echo "--> Repair from ID enabled: will re-check previously converted rows against workflowDefinitionId."
fi

if [[ ${QUIET} -eq 1 ]]; then
  CMD_ARGS+=("--quiet")
fi

if [[ -n "${COLLECTION}" ]]; then
  CMD_ARGS+=("--collection=${COLLECTION}")
fi

if [[ -n "${TABLE}" ]]; then
  CMD_ARGS+=("--table=${TABLE}")
fi

WORKDIR=""

case "${STORE}" in
  mongo)
    WORKDIR="${REACTORY_ROOT}/reactory-express-server"
    URL="${CUSTOM_URL:-${MONGOOSE}}"
    if [[ -z "${URL}" ]]; then
      echo "ERROR: No MongoDB connection URL provided. Set MONGOOSE in .env or pass --url."
      exit 1
    fi
    CMD_ARGS+=("--url=${URL}")
    ;;
  sqlite)
    WORKDIR="${WORKFLOW_ES_ROOT}/providers/workflow-es-sqlite"
    DB_PATH="${CUSTOM_PATH:-/tmp/workflow.db}"
    CMD_ARGS+=("--path=${DB_PATH}")
    ;;
  postgres)
    WORKDIR="${WORKFLOW_ES_ROOT}/providers/workflow-es-postgres"
    URL="${CUSTOM_URL:-${WORKFLOW_POSTGRES_URL:-${REACTORY_POSTGRES_URL}}}"
    if [[ -z "${URL}" ]]; then
      # Construct default postgres URL from ENV if components available
      PG_HOST="${REACTORY_POSTGRES_HOST:-localhost}"
      PG_PORT="${REACTORY_POSTGRES_PORT:-5432}"
      PG_USER="${REACTORY_POSTGRES_USER:-reactory}"
      PG_PASS="${REACTORY_POSTGRES_PASSWORD:-reactory}"
      PG_DB="${REACTORY_POSTGRES_DB:-reactory}"
      URL="postgres://${PG_USER}:${PG_PASS}@${PG_HOST}:${PG_PORT}/${PG_DB}"
    fi
    CMD_ARGS+=("--url=${URL}")
    ;;
  *)
    echo "ERROR: Unsupported store '${STORE}'. Choose 'mongo', 'sqlite', or 'postgres'."
    exit 1
    ;;
esac

if [[ ! -d "${WORKDIR}" ]]; then
  echo "ERROR: Working directory '${WORKDIR}' does not exist."
  exit 1
fi

echo "--> Executing M11 Migration using working dir: ${WORKDIR}"
cd "${WORKDIR}"
node "${MIGRATION_SCRIPT}" "${CMD_ARGS[@]}"
