import { describe, expect, it } from "vitest";
import { createTodoBridge } from "./todo_bridge.js";
import type { ServerMessage, TodoTaskWire } from "./protocol/types.js";

// ── Fake session branch ─────────────────────────────────────────────────────
// The bridge reads `ctx.sessionManager.getBranch()`. Entries are plain objects,
// exactly the `custom` entries pi-todo appends (`type` + `customType` + `data`),
// and the array is mutated in place so identity of the branch stays stable —
// the same shape the SDK hands an extension.

type Branch = unknown[];

function ctxOf(branch: Branch): unknown {
  return { sessionManager: { getBranch: () => branch } };
}

const EMPTY_SNAPSHOT = { action: "clear", params: {}, tasks: [], nextId: 1 };

function snapshot(
  tasks: Array<Record<string, unknown>>,
  nextId = tasks.length + 1,
) {
  return { action: "update", params: {}, tasks, nextId };
}

function stateEntry(data: unknown): unknown {
  return { type: "custom", id: `e${Math.random()}`, customType: "rpiv-todo-state", data };
}

function task(overrides: Record<string, unknown> = {}) {
  return { id: 1, subject: "Write the parser", status: "pending", ...overrides };
}

function frame(tasks: TodoTaskWire[]): ServerMessage {
  return { type: "todo_state", tasks };
}

/** Bridge + the frames it broadcast, in order. */
function bridge() {
  const sent: ServerMessage[] = [];
  return { sent, bridge: createTodoBridge((msg) => sent.push(msg)) };
}

describe("createTodoBridge", () => {
  it("publishes the branch snapshot, tombstone rows filtered out", () => {
    const { sent, bridge: b } = bridge();
    const branch: Branch = [
      stateEntry(
        snapshot([
          task({ id: 2, subject: "Second", status: "in_progress", activeForm: "writing tests" }),
          task({ id: 1, subject: "First", status: "completed" }),
          task({ id: 3, subject: "Gone", status: "deleted" }),
        ]),
      ),
    ];
    b.refresh(ctxOf(branch));
    expect(sent).toEqual([
      frame([
        { id: 1, subject: "First", status: "completed" },
        { id: 2, subject: "Second", status: "in_progress", active_form: "writing tests" },
      ]),
    ]);
  });

  it("carries blocked_by and owner through, and drops the fields when absent", () => {
    const { sent, bridge: b } = bridge();
    const branch: Branch = [
      stateEntry(
        snapshot([task({ id: 1 }), task({ id: 2, blockedBy: [1, 99], owner: "agent" })]),
      ),
    ];
    b.refresh(ctxOf(branch));
    const tasks = (sent[0] as Extract<ServerMessage, { type: "todo_state" }>).tasks;
    expect(tasks[1]).toEqual({ id: 2, subject: "Write the parser", status: "pending", blocked_by: [1, 99], owner: "agent" });
    expect(tasks[0]).not.toHaveProperty("blocked_by");
    expect(tasks[0]).not.toHaveProperty("owner");
  });

  it("takes the last snapshot on the branch (last write wins)", () => {
    const { sent, bridge: b } = bridge();
    const branch: Branch = [
      stateEntry(snapshot([task({ id: 1 })])),
      stateEntry(snapshot([task({ id: 1, status: "completed" })])),
    ];
    b.refresh(ctxOf(branch));
    expect(sent).toEqual([frame([{ id: 1, subject: "Write the parser", status: "completed" }])]);
  });

  it("stays quiet when the list did not change", () => {
    const { sent, bridge: b } = bridge();
    const branch: Branch = [stateEntry(snapshot([task()]))];
    b.refresh(ctxOf(branch));
    b.refresh(ctxOf(branch));
    branch.push({ type: "message", message: { role: "assistant", content: [] } });
    b.refresh(ctxOf(branch));
    expect(sent).toHaveLength(1);
  });

  it("republishes when the list changes", () => {
    const { sent, bridge: b } = bridge();
    const branch: Branch = [stateEntry(snapshot([task()]))];
    b.refresh(ctxOf(branch));
    branch.push(stateEntry(snapshot([task({ status: "in_progress" })])));
    b.refresh(ctxOf(branch));
    expect(sent.at(-1)).toEqual(
      frame([{ id: 1, subject: "Write the parser", status: "in_progress" }]),
    );
  });

  it("rebuilds from the first entry after the branch is rewritten (fork / tree)", () => {
    const { sent, bridge: b } = bridge();
    const survivor = stateEntry(snapshot([task({ id: 1, subject: "Kept" })]));
    const branch: Branch = [survivor, stateEntry(snapshot([task({ id: 2 })])), { type: "message" }];
    b.refresh(ctxOf(branch));
    // `/tree` rewind: the branch now ends elsewhere, ending on the survivor.
    branch.length = 0;
    branch.push(survivor, { type: "message", message: { role: "assistant" } });
    b.refresh(ctxOf(branch));
    expect(sent.at(-1)).toEqual(frame([{ id: 1, subject: "Kept", status: "pending" }]));
  });

  it("rebuilds when a fork leaves the branch longer but replaces its tail", () => {
    const { sent, bridge: b } = bridge();
    const shared = { type: "message", message: { role: "user" } };
    const branch: Branch = [
      shared,
      stateEntry(snapshot([task({ id: 1, subject: "Before the fork" })])),
      { type: "message" },
    ];
    b.refresh(ctxOf(branch));
    expect(sent.at(-1)).toEqual(
      frame([{ id: 1, subject: "Before the fork", status: "pending" }]),
    );

    // Fork at `shared`: the length did not shrink, so only the identity check
    // can catch it — this is the path that would otherwise keep scanning from a
    // cursor that now points into a different branch.
    branch.length = 0;
    branch.push(
      shared,
      stateEntry(snapshot([task({ id: 5, subject: "After the fork" })])),
      { type: "message" },
      { type: "message" },
    );
    b.refresh(ctxOf(branch));
    expect(sent.at(-1)).toEqual(
      frame([{ id: 5, subject: "After the fork", status: "pending" }]),
    );
  });

  it("replays a session that predates the state entries from its todo toolResult", () => {
    const { sent, bridge: b } = bridge();
    const branch: Branch = [
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "todo",
          details: snapshot([task({ id: 3, subject: "Only in the toolResult" })]),
        },
      },
    ];
    b.refresh(ctxOf(branch));
    expect(sent.at(-1)).toEqual(
      frame([{ id: 3, subject: "Only in the toolResult", status: "pending" }]),
    );
  });

  it("prefers a state entry over a newer-looking toolResult", () => {
    const { sent, bridge: b } = bridge();
    const branch: Branch = [
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "todo",
          details: snapshot([task({ id: 1, subject: "ToolResult copy" })]),
        },
      },
      stateEntry(snapshot([task({ id: 1, subject: "Entry copy", status: "completed" })])),
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "todo",
          details: snapshot([task({ id: 1, subject: "Stale toolResult" })]),
        },
      },
    ];
    b.refresh(ctxOf(branch));
    expect(sent.at(-1)).toEqual(
      frame([{ id: 1, subject: "Entry copy", status: "completed" }]),
    );
  });

  it("forwards an unknown status instead of dropping the row", () => {
    const { sent, bridge: b } = bridge();
    b.refresh(ctxOf([stateEntry(snapshot([task({ id: 1, subject: "Newer state", status: "blocked" })]))]));
    expect(sent.at(-1)).toEqual(
      frame([{ id: 1, subject: "Newer state", status: "blocked" }]),
    );
  });

  it("drops a blank subject so the count matches the Pi panel", () => {
    const { sent, bridge: b } = bridge();
    b.refresh(
      ctxOf([stateEntry(snapshot([task({ id: 1, subject: "   " }), task({ id: 2, subject: "Real" })]))]),
    );
    expect(sent.at(-1)).toEqual(frame([{ id: 2, subject: "Real", status: "pending" }]));
  });

  it("survives a session manager that throws", () => {
    const { sent, bridge: b } = bridge();
    b.refresh({
      sessionManager: {
        getBranch: () => {
          throw new Error("session manager not ready");
        },
      },
    });
    expect(sent).toEqual([]);
  });

  it("ignores other extensions' custom entries and malformed snapshots", () => {
    const { sent, bridge: b } = bridge();
    const branch: Branch = [
      { type: "custom", customType: "some-other-extension", data: { tasks: [task()] } },
      stateEntry({ tasks: "not-a-list" }),
      stateEntry({ tasks: [{ id: "1", subject: "bad id", status: "pending" }] }),
      stateEntry(null),
      { type: "custom", customType: "rpiv-todo-state" },
    ];
    b.refresh(ctxOf(branch));
    expect(sent).toEqual([frame([])]);
  });

  it("publishes the empty list once when pi-todo never wrote a snapshot", () => {
    const { sent, bridge: b } = bridge();
    b.refresh(ctxOf([{ type: "message" }]));
    b.refresh(ctxOf([{ type: "message" }, { type: "message" }]));
    expect(sent).toEqual([frame([])]);
  });

  it("does nothing when the session manager is unavailable", () => {
    const { sent, bridge: b } = bridge();
    b.refresh({});
    b.refresh(null);
    expect(sent).toEqual([]);
  });

  it("reset + refresh clears a replaced session's list", () => {
    const { sent, bridge: b } = bridge();
    const branch: Branch = [stateEntry(snapshot([task()]))];
    b.refresh(ctxOf(branch));
    expect(sent).toHaveLength(1);
    // `/new`: a different, empty branch.
    b.reset();
    b.refresh(ctxOf([{ type: "message", message: { role: "user" } }]));
    expect(sent.at(-1)).toEqual(frame([]));
    expect(sent).toHaveLength(2);
  });

  it("current() answers a later session_sync with the remembered list", () => {
    const { bridge: b } = bridge();
    expect(b.current()).toEqual(frame([]));
    b.refresh(ctxOf([stateEntry(snapshot([task({ id: 7, subject: "Later" })]))]));
    expect(b.current()).toEqual(frame([{ id: 7, subject: "Later", status: "pending" }]));
  });

  it("hands out a frame that a caller cannot mutate back into the state", () => {
    const { bridge: b } = bridge();
    b.refresh(ctxOf([stateEntry(snapshot([task()]))]));
    const first = b.current() as Extract<ServerMessage, { type: "todo_state" }>;
    first.tasks[0].subject = "mutated by the sender";
    expect(b.current()).toEqual(frame([{ id: 1, subject: "Write the parser", status: "pending" }]));
  });

  it("publish() goes through the same change gate as any other update", () => {
    const { sent, bridge: b } = bridge();
    b.refresh(ctxOf([stateEntry(snapshot([task()]))]));
    b.publish();
    // An unchanged list is not re-broadcast; a new device is served by
    // `current()` on `session_sync`, not by this.
    expect(sent).toHaveLength(1);
    b.reset();
    b.publish();
    expect(sent.at(-1)).toEqual(frame([]));
  });

  it("treats a cleared list as a change", () => {
    const { sent, bridge: b } = bridge();
    const branch: Branch = [stateEntry(snapshot([task()]))];
    b.refresh(ctxOf(branch));
    branch.push(stateEntry(EMPTY_SNAPSHOT));
    b.refresh(ctxOf(branch));
    expect(sent.at(-1)).toEqual(frame([]));
  });
});
