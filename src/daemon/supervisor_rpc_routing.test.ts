import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";
import { join } from "node:path";
import { Supervisor, getSupervisorSockPath } from "./supervisor.js";
import { addDaemon } from "./registry.js";
import { daemonIdForCwd } from "./id.js";
import { roomIdFor } from "../rooms.js";
import { defaultAgentName } from "../session/local_config.js";
import {
  encodeRequest,
  parseReply,
  type ControlReply,
  type ControlRequest,
} from "./control_protocol.js";

/**
 * `op: "rpc"` routing — registry daemons vs ephemeral (phone-forked) rooms.
 *
 * Regression for the fork bug: a fork room's extension addressed its RPC
 * commands with `daemonIdForCwd(cwd)` — the cwd's REGISTRY daemon id — and
 * the supervisor resolved the registry map only, so every RPC action of a
 * fork (the session picker's `switch_session`, `/extension` commands) was
 * delivered to the SOURCE room's process: picking a session to continue in
 * a fork replaced the other room's live conversation. The fix: the child
 * carries its own `pid` (and, for ephemeral rooms, its relay room_id), and
 * the supervisor resolves by pid first, then id (registry map, then
 * ephemeral map).
 *
 * The "Pi" here is a node stub that answers every RPC line on stdin with a
 * `response` carrying a marker of its own `{pid, cwd, ephemeral}`, so each
 * test can prove WHICH process actually received the command. The stub also
 * writes its pid to `.pi-pid-eph` / `.pi-pid-daemon` in its cwd so the
 * test can address the child explicitly.
 */

let testHome: string;
let supervisor: Supervisor | null = null;
let stubPi: string;

async function ask<R = ControlReply<unknown>>(req: ControlRequest): Promise<R> {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ path: getSupervisorSockPath() });
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        sock.destroy();
        try { resolve(parseReply(buf.slice(0, nl)) as R); }
        catch (e) { reject(e); }
      }
    });
    sock.on("error", reject);
    sock.write(encodeRequest(req));
  });
}

type RpcReplyData = {
  id?: string;
  delivered?: boolean;
  response?: { success?: boolean; data?: { marker?: { pid: number; cwd: string; ephemeral: boolean } } };
};

/** Polls until the stub child has written its pid file, and returns the pid. */
async function waitForPid(cwd: string, file: string): Promise<number> {
  const path = join(cwd, file);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const pid = Number(readFileSync(path, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`pid file ${path} did not appear`);
}

beforeEach(async () => {
  testHome = mkdtempSync(join(tmpdir(), "pi-sv-rpc-"));
  process.env["REMOTE_PI_HOME"] = testHome;
  stubPi = join(testHome, "fake-pi-rpc.js");
  writeFileSync(
    stubPi,
    "#!/usr/bin/env node\n" +
    "const fs = require(\"node:fs\");\n" +
    "const { join } = require(\"node:path\");\n" +
    "const ephemeral = process.env[\"REMOTE_PI_EPHEMERAL\"] === \"1\";\n" +
    "fs.writeFileSync(join(process.cwd(), ephemeral ? \".pi-pid-eph\" : \".pi-pid-daemon\"), String(process.pid));\n" +
    "const marker = { pid: process.pid, cwd: process.cwd(), ephemeral };\n" +
    "let buf = \"\";\n" +
    "process.stdin.setEncoding(\"utf8\");\n" +
    "process.stdin.on(\"data\", (chunk) => {\n" +
    "  buf += chunk;\n" +
    "  let nl;\n" +
    "  while ((nl = buf.indexOf(\"\\n\")) >= 0) {\n" +
    "    const line = buf.slice(0, nl);\n" +
    "    buf = buf.slice(nl + 1);\n" +
    "    let m;\n" +
    "    try { m = JSON.parse(line); } catch { continue; }\n" +
    "    if (!m || typeof m.type !== \"string\" || typeof m.id !== \"string\") continue;\n" +
    "    process.stdout.write(JSON.stringify({ type: \"response\", id: m.id, command: m.type, success: true, data: { marker } }) + \"\\n\");\n" +
    "  }\n" +
    "});\n" +
    "setInterval(() => {}, 1 << 30);\n",
  );
  chmodSync(stubPi, 0o755);
  supervisor = new Supervisor({ extensionPath: "/no/such/extension.js", piBin: stubPi });
  await supervisor.start();
});

afterEach(async () => {
  if (supervisor) {
    await supervisor.stop();
    supervisor = null;
  }
  delete process.env["REMOTE_PI_HOME"];
  try { rmSync(testHome, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function markerOf(reply: ControlReply<unknown>): { pid: number; cwd: string; ephemeral: boolean } | undefined {
  const data = (reply.data ?? {}) as RpcReplyData;
  return data.response?.data?.marker;
}

describe("Supervisor — rpc passthrough routing (registry vs ephemeral)", () => {
  test("rpc reaches a running ephemeral room by its relay room_id", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "pi-rpc-roomid-"));
    const spawn = await ask({ op: "spawn", cwd: tmp, name: "proj" }) as ControlReply<{
      room_id: string; started: boolean; name: string;
    }>;
    expect(spawn.ok).toBe(true);
    const roomId = spawn.ok ? spawn.data!.room_id : roomIdFor(tmp, "proj");
    const r = await ask({ op: "rpc", id: roomId, command: { type: "get_state" }, timeout_ms: 2_000 });
    expect(r.ok).toBe(true);
    expect(r.ok && (r.data as RpcReplyData).delivered).toBe(true);
    expect(markerOf(r)).toMatchObject({ ephemeral: true, cwd: realpathSync(tmp) });
  });

  test("rpc with a mismatched predicted room_id still reaches the caller via its own pid", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "pi-rpc-pid-"));
    await ask({ op: "spawn", cwd: tmp, name: "proj" });
    const pid = await waitForPid(tmp, ".pi-pid-eph");
    // A wrong id (the cwd lock landed on a neighbouring #N) — the pid must
    // carry the routing, not the id.
    const r = await ask({
      op: "rpc",
      id: "deadbeef0000",
      pid,
      command: { type: "get_state" },
      timeout_ms: 2_000,
    });
    expect(r.ok).toBe(true);
    expect(markerOf(r)).toMatchObject({ pid, ephemeral: true, cwd: realpathSync(tmp) });
  });

  test("a fork's rpc addressed with the cwd-only daemon id (the old, buggy address) reaches the FORK, not the sibling daemon", async () => {
    // The reported bug: daemon + fork share a cwd. The fork's old extension
    // code sent `daemonIdForCwd(cwd)` — the daemon's id — so its session
    // picker drove the daemon's process (the other room). With the pid hint
    // the same request must land on the fork's own child.
    const tmp = mkdtempSync(join(tmpdir(), "pi-rpc-fork-"));
    const reg = addDaemon(tmp);
    const start = await ask({ op: "start", id: reg.id });
    expect(start.ok).toBe(true);
    const forkName = `${defaultAgentName(tmp)}#2`;
    const spawn = await ask({ op: "spawn", cwd: tmp, name: forkName }) as ControlReply<{ name: string }>;
    expect(spawn.ok && spawn.data!.name).toBe(forkName);
    const ephPid = await waitForPid(tmp, ".pi-pid-eph");
    const daemonPid = await waitForPid(tmp, ".pi-pid-daemon");
    expect(ephPid).not.toBe(daemonPid);

    // The buggy address (cwd-only daemon id) + the fork's own pid.
    const byPid = await ask({
      op: "rpc",
      id: daemonIdForCwd(tmp),
      pid: ephPid,
      command: { type: "switch_session", sessionPath: "/no/such/session.jsonl" },
      timeout_ms: 2_000,
    });
    expect(byPid.ok).toBe(true);
    expect(markerOf(byPid)).toMatchObject({ pid: ephPid, ephemeral: true });

    // The fixed address: the extension-side prediction — roomIdFor of the
    // ANNOUNCED name — must equal the supervisor's ephemeral map key, so
    // the id path alone reaches the fork (the pid hint covers drift).
    const roomId = roomIdFor(realpathSync(tmp), forkName);
    const byRoomId = await ask({ op: "rpc", id: roomId, command: { type: "get_state" }, timeout_ms: 2_000 });
    expect(byRoomId.ok).toBe(true);
    expect(markerOf(byRoomId)).toMatchObject({ pid: ephPid, ephemeral: true });
  });

  test("a daemon room's rpc by registry id (no pid) still reaches the daemon", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "pi-rpc-daemon-"));
    const reg = addDaemon(tmp);
    const start = await ask({ op: "start", id: reg.id });
    expect(start.ok).toBe(true);
    const daemonPid = await waitForPid(tmp, ".pi-pid-daemon");
    const r = await ask({ op: "rpc", id: reg.id, command: { type: "get_state" }, timeout_ms: 2_000 });
    expect(r.ok).toBe(true);
    expect(markerOf(r)).toMatchObject({ pid: daemonPid, ephemeral: false, cwd: realpathSync(tmp) });
  });

  test("a daemon room's rpc carrying its own pid still reaches the daemon", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "pi-rpc-daemonpid-"));
    const reg = addDaemon(tmp);
    const start = await ask({ op: "start", id: reg.id });
    expect(start.ok).toBe(true);
    const daemonPid = await waitForPid(tmp, ".pi-pid-daemon");
    const r = await ask({
      op: "rpc",
      id: reg.id,
      pid: daemonPid,
      command: { type: "get_state" },
      timeout_ms: 2_000,
    });
    expect(r.ok).toBe(true);
    expect(markerOf(r)).toMatchObject({ pid: daemonPid, ephemeral: false });
  });

  test("rpc with a pid that matches no child falls back to the id, and to a clean error", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "pi-rpc-stalepid-"));
    const reg = addDaemon(tmp);
    const start = await ask({ op: "start", id: reg.id });
    expect(start.ok).toBe(true);
    await waitForPid(tmp, ".pi-pid-daemon");
    // A stale pid (the child was restarted) + a valid registry id → the id
    // path must still deliver.
    const r = await ask({
      op: "rpc",
      id: reg.id,
      pid: 999_999_999,
      command: { type: "get_state" },
      timeout_ms: 2_000,
    });
    expect(r.ok).toBe(true);
    expect((r.data as RpcReplyData).delivered).toBe(true);
    // Stale pid + unknown id → the old error, not a timeout.
    const e = await ask({
      op: "rpc",
      id: "ffffffff",
      pid: 999_999_999,
      command: { type: "get_state" },
      timeout_ms: 2_000,
    });
    expect(e.ok).toBe(false);
    expect(e.ok ? "" : e.error).toContain("not running");
  });
});
