export var WorkflowStatus = {
    Runnable : 0,
    Suspended : 1,
    Complete : 2,
    Terminated : 3,
    DeadLettered : 4      // terminal: retries exhausted; never runnable, never re-queued
}