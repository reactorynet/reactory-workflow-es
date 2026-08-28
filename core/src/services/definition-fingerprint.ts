import { WorkflowStepBase } from "../models";

/**
 * M10 — Workflow-definition fingerprinting.
 *
 * ## Why this exists
 *
 * Execution pointers reference steps by an ORDINAL index: `WorkflowBuilder.addStep`
 * assigns `step.id = this.steps.length`, and the executor resumes a pointer with
 * `def.steps.find(x => x.id == pointer.stepId)`. Step identity is therefore purely
 * positional — it is not a stable name, and it is not content-addressed.
 *
 * M1 protects instances whose `(workflowDefinitionId, version)` pair is no longer
 * registered. It cannot protect an instance whose pair IS still registered but now
 * resolves to a DIFFERENT step graph — which happens whenever a definition is edited
 * without a version bump (in this codebase, most easily via the YAML catalog, whose
 * files are overwritten in place at `<ns>/<name>/<version>/<name>.yaml`).
 *
 * The failure is silent and severe: an instance suspended at `stepId: 4` resumes and
 * executes whatever step now occupies index 4 — with the wrong compensation graph if
 * it is a saga. No error is raised, because the registry lookup still succeeds.
 *
 * A fingerprint closes that hole. The graph shape is hashed at registration, stamped
 * onto the instance at start, and re-checked on every load. A mismatch means the graph
 * moved underneath a running instance and the instance is dead-lettered rather than
 * executed against a definition it was not started on.
 *
 * ## What is hashed — and what deliberately is not
 *
 * Only the fields that give `pointer.stepId` its meaning:
 *
 *   - the number of steps, and each step's ordinal `id`
 *   - `name` and the step-body CLASS NAME (a step swapped for a different body at the
 *     same index is a different graph)
 *   - `outcomes[].nextStep` IN ORDER (the graph edges; outcome order is evaluation order)
 *   - `children` IN ORDER (parallel/foreach branch wiring)
 *   - `compensationStepId` (saga wiring)
 *
 * Deliberately EXCLUDED, because they do not change what a stepId refers to and
 * excluding them keeps false positives — which dead-letter live work — to a minimum:
 *
 *   - `errorBehavior`, `retryInterval`, `maxRetries`: retry/error policy is operational
 *     tuning, not graph shape. Re-tuning a retry interval must not kill in-flight work.
 *   - `inputs` / `outputs`: these are CLOSURES. `Function.prototype.toString()` is not a
 *     dependable identity — it varies with transpiler and minifier output, and for
 *     YAML-generated workflows every leaf step closes over the same source text
 *     (`attachLeaf` binds one `YamlStepBody` closure for all leaves), so it would
 *     discriminate nothing while producing spurious mismatches across rebuilds.
 *   - `StepOutcome.value`: also a closure, same reasoning. Its `nextStep` IS hashed.
 *
 * ## Covering content, not just shape
 *
 * Because closures are excluded, a change to a leaf step's CONFIGURATION (a URL, a
 * template) is invisible to the structural hash. Callers that hold the authoritative
 * source text can close that gap with `fingerprintSeed` on {@link WorkflowBase}: the
 * seed is folded into the hash, so binding it to a digest of the raw definition source
 * (e.g. the YAML file) makes any content edit a fingerprint change. The engine stays
 * agnostic about what the seed means.
 *
 * ## Hash choice
 *
 * FNV-1a, two 64-bit lanes with distinct offset bases, rendered as 32 lowercase hex
 * characters. This is a DRIFT DETECTOR, not a security control — it defends against
 * accidental edits, never against an adversary crafting a collision. FNV-1a is chosen
 * over `node:crypto` deliberately: it is dependency-free, synchronous, and identical in
 * Node, Electron and the browser, so the core package acquires no platform dependency
 * (the package targets all three — see README § Electron packaging). Accidental
 * collision probability at 128 bits is negligible for this purpose.
 */

/** Version tag for the canonical form. Bump if the canonicalisation rules change. */
const CANONICAL_FORM_VERSION = "wfes-fp-1";

const FNV_PRIME = 1099511628211n;
const MASK_64 = 0xffffffffffffffffn;

/** Standard FNV-1a 64-bit offset basis. */
const LANE_A_BASIS = 14695981039346656037n;
/** Second lane: a distinct basis so the two lanes fail independently. */
const LANE_B_BASIS = 0x9e3779b97f4a7c15n;

/** One FNV-1a 64-bit lane over the UTF-8 code units of `input`. */
function fnv1a64(input: string, basis: bigint): bigint {
    let hash = basis;
    for (let i = 0; i < input.length; i++) {
        hash ^= BigInt(input.charCodeAt(i) & 0xff);
        hash = (hash * FNV_PRIME) & MASK_64;
        // Mix the high byte of multi-byte code units so non-ASCII step names
        // (which are legal) still contribute their full value.
        const high = input.charCodeAt(i) >> 8;
        if (high !== 0) {
            hash ^= BigInt(high);
            hash = (hash * FNV_PRIME) & MASK_64;
        }
    }
    return hash;
}

/** Render a 64-bit lane as 16 lowercase hex characters. */
function toHex64(value: bigint): string {
    return value.toString(16).padStart(16, "0");
}

/**
 * Build the canonical string form of a step graph.
 *
 * Exported for tests and diagnostics: when a fingerprint mismatch is reported, diffing
 * the canonical forms of the two graphs shows exactly which step moved.
 *
 * Steps are emitted sorted by ordinal `id` so the form does not depend on array order,
 * while `outcomes` and `children` retain their declared order because that order is
 * semantically meaningful (evaluation order / branch order).
 */
export function canonicalDefinitionForm(steps: Array<WorkflowStepBase>, seed?: string): string {
    const safe = (value: any): string =>
        value === undefined || value === null ? "" : String(value).replace(/[|\n]/g, "_");

    const ordered = (steps || []).slice().sort((a, b) => (a.id || 0) - (b.id || 0));

    const lines: string[] = [
        CANONICAL_FORM_VERSION,
        `seed:${safe(seed)}`,
        `steps:${ordered.length}`,
    ];

    for (const step of ordered) {
        // The body is a constructor; its class name is the stable part. An anonymous
        // class contributes "" — the surrounding wiring still discriminates the graph.
        const bodyName = step.body && (step.body as any).name ? (step.body as any).name : "";
        const outcomes = (step.outcomes || []).map(o => safe(o ? o.nextStep : "")).join(",");
        const children = (step.children || []).map(c => safe(c)).join(",");

        lines.push(
            [
                safe(step.id),
                safe(step.name),
                safe(bodyName),
                outcomes,
                children,
                safe(step.compensationStepId),
            ].join("|")
        );
    }

    return lines.join("\n");
}

/**
 * Compute the fingerprint of a step graph.
 *
 * Deterministic across processes, hosts and restarts for an unchanged graph — the
 * whole guarantee depends on that, so the canonical form must never incorporate
 * object identity, iteration order of a Map/Set, or a timestamp.
 *
 * @param steps The built definition's steps.
 * @param seed  Optional caller-supplied content digest folded into the hash. See the
 *              module docblock — this is how a YAML/source-backed definition makes a
 *              configuration edit visible to a structural hash.
 * @returns 32 lowercase hex characters.
 */
export function computeDefinitionFingerprint(steps: Array<WorkflowStepBase>, seed?: string): string {
    const canonical = canonicalDefinitionForm(steps, seed);
    return toHex64(fnv1a64(canonical, LANE_A_BASIS)) + toHex64(fnv1a64(canonical, LANE_B_BASIS));
}
