// Plan/63 — mirror the pi-todo (`rpiv-todo`) task list to the paired app.
//
// rpiv-todo registers the `todo` tool and writes the FULL post-mutation snapshot
// onto the session branch as a `custom` entry of type `rpiv-todo-state` on every
// change — that is how its own TUI panel survives /reload, /resume and
// compaction. We read the same entries instead of tracking the tool calls: a
// `todo` invoked from a codemode script never lands as its own toolResult, so a
// call-site hook would silently miss it, and the branch (not the tool events) is
// also what a re-sync after a daemon restart replays.
//
// Inert when pi-todo is absent: no entries, no frames, and the app keeps its
// todo affordance hidden. The entry type and the snapshot shape are pi-todo's
// published persistence contract (docs/tool-schema.md), not an internal.
/** pi-todo's persistence key (STATE_ENTRY_TYPE in the package). */
const STATE_ENTRY_TYPE = "rpiv-todo-state";
/**
 * The state every snapshot carries for a tombstone. Everything else is
 * forwarded as-is: a newer pi-todo may add a state, and dropping the row would
 * then silently break the app's counts (its renderer already falls back to a
 * neutral row for states it doesn't know).
 */
const DELETED_STATUS = "deleted";
/**
 * Reads the last `rpiv-todo-state` snapshot on the branch and keeps a wire
 * frame in sync with it.
 *
 * `broadcast` is the host's fan-out to attached owners; the bridge itself holds
 * no subscriptions, so there is nothing to dispose.
 */
export function createTodoBridge(broadcast) {
    // Index of the first branch entry not scanned yet, plus the entry the cursor
    // points past — enough to notice that the branch was rewritten under us.
    let cursor = 0;
    let lastEntry = undefined;
    // The two replay sources pi-todo itself keeps (state entries, then the last
    // `todo` toolResult's details when a session predates the entries).
    let fromEntries = null;
    let fromToolResults = null;
    let tasks = [];
    // Serialized form of the last broadcast list: the gate that keeps a refresh
    // after every tool result from re-sending an unchanged list. `null` means
    // "nothing broadcast yet" (fresh bridge, or reset for a new session), so the
    // very next setTasks always reaches the app — even with the empty list, which
    // is how a replaced session clears the previous one's list.
    let published = null;
    function refresh(ctx) {
        const entries = branchEntries(ctx);
        if (!entries)
            return;
        // A fork / tree navigation / session swap hands us a different branch: the
        // cursor no longer lines up, so rebuild from the first entry instead of
        // scanning forward from a position that means nothing anymore.
        const rewritten = entries.length < cursor || (cursor > 0 && entries[cursor - 1] !== lastEntry);
        if (rewritten) {
            fromEntries = null;
            fromToolResults = null;
        }
        // pi-todo's own replay keeps a second, weaker source: the `details` of the
        // last `todo` toolResult. Sessions written before the state entries existed
        // carry only that one, and pi-todo's panel still shows their list — so
        // reading entries alone would show the phone nothing the desktop shows.
        // Entries always win (they are written at commit time for every change).
        for (let i = rewritten ? 0 : cursor; i < entries.length; i += 1) {
            const entry = entries[i];
            if (!entry || typeof entry !== "object")
                continue;
            if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE) {
                const next = toTaskList(entry.data);
                if (next)
                    fromEntries = next;
                continue;
            }
            if (entry.type !== "message")
                continue;
            const message = entry.message;
            if (message?.role !== "toolResult" || message.toolName !== TODO_TOOL_NAME)
                continue;
            const next = toTaskList(message.details);
            if (next)
                fromToolResults = next;
        }
        cursor = entries.length;
        lastEntry = entries[entries.length - 1];
        setTasks(fromEntries ?? fromToolResults ?? []);
    }
    function setTasks(next) {
        tasks = next;
        const json = JSON.stringify(next); // Compare against what was last BROADCAST, not against `tasks`: a list that
        // was reset and then re-read identically still needs to reach a reconnecting
        // app.
        if (json === published)
            return;
        published = json;
        broadcast(frame());
    }
    function frame() {
        return { type: "todo_state", tasks: tasks.map((t) => ({ ...t })) };
    }
    return {
        refresh,
        reset() {
            cursor = 0;
            lastEntry = undefined;
            fromEntries = null;
            fromToolResults = null;
            tasks = [];
            published = null;
        },
        publish() {
            setTasks(tasks);
        },
        current() {
            return frame();
        },
    };
}
/** pi-todo's tool name — the branch replay key for pre-entry sessions. */
const TODO_TOOL_NAME = "todo";
/** The branch's entries, or null when this build exposes no session manager. */
function branchEntries(ctx) {
    try {
        const manager = ctx?.sessionManager;
        // The ACTIVE leaf branch, not the flat entry list: after `/fork` or tree
        // navigation the two diverge, and the room should mirror what the agent's
        // context actually is.
        const entries = manager?.getBranch?.() ?? manager?.getEntries?.();
        return Array.isArray(entries) ? entries : null;
    }
    catch {
        // Called from `tool_execution_end` (every tool result, mid-turn): a host
        // whose session manager throws must not take the rest of that handler down
        // with it. Same guard as the other branch readers in this package.
        return null;
    }
}
/**
 * Wire rows from a persisted snapshot, or null when the payload is not one
 * (another extension's entry, an older/never-written shape, corrupt data).
 */
function toTaskList(data) {
    const snapshot = data;
    if (!snapshot || typeof snapshot !== "object")
        return null;
    const rows = snapshot.tasks;
    if (!Array.isArray(rows))
        return null;
    const out = [];
    for (const row of rows) {
        const task = row;
        if (!task || typeof task !== "object")
            continue;
        if (typeof task.id !== "number" || typeof task.subject !== "string")
            continue;
        // A blank subject is not a row anyone can identify — the app drops it too,
        // so dropping it here is what keeps its count equal to the Pi panel's.
        if (task.subject.trim() === "")
            continue;
        // Tombstones are the only state filtered out; anything else is forwarded
        // verbatim so a newer pi-todo's extra state still reaches the phone.
        if (typeof task.status !== "string" || task.status === DELETED_STATUS)
            continue;
        out.push({
            id: task.id,
            subject: task.subject,
            status: task.status,
            ...(typeof task.activeForm === "string" && task.activeForm
                ? { active_form: task.activeForm }
                : {}),
            ...(Array.isArray(task.blockedBy)
                ? { blocked_by: task.blockedBy.filter((id) => typeof id === "number") }
                : {}),
            ...(typeof task.owner === "string" && task.owner ? { owner: task.owner } : {}),
        });
    }
    // pi-todo appends in creation order and ids only ever grow, but sorting keeps
    // the app's row order literal-id order even if a snapshot ever comes back
    // reordered.
    out.sort((a, b) => a.id - b.id);
    return out;
}
//# sourceMappingURL=todo_bridge.js.map