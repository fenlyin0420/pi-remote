/**
 * Chunked Pi → App file push (`session/file_send.ts`).
 *
 * The invariants worth pinning: the file goes out in order, every chunk waits
 * for the app's ack (that is the backpressure), the sha256 covers exactly the
 * bytes that were sent, and every way this can fail comes back typed with a
 * message the model can act on — a refused offer, a silent phone, a file that
 * changed under us.
 */
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { closeSync, ftruncateSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientMessage, ServerMessage } from "../protocol/types.js";

const {
  FILE_SEND_CHUNK_BYTES,
  FILE_SEND_MAX_BYTES,
  FileSendHub,
  sendFileChunked,
} = await import("./file_send.js");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rp-filesend-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, bytes: Buffer | string): string {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

type Frame = ServerMessage & { type: "file_send_start" | "file_send_chunk" | "file_send_end" };

/** A stand-in phone: records the frames and answers them like the app does. */
function makePhone(opts: {
  /** Answer the offer at all (false = an app too old for these frames). */
  ready?: boolean;
  /** Refuse with this message instead of accepting. */
  abortOnStart?: string;
  /** Fail the transfer at this chunk index. */
  abortAtChunk?: { index: number; message: string };
  /** Verify the sha the Pi declared (default true). */
  verifyHash?: boolean;
  /** Called after each chunk ack, for mid-transfer interference. */
  onAck?: (index: number) => void;
  /** Answer asynchronously (a real transport) instead of inline. */
  async?: boolean;
}) {
  const frames: Frame[] = [];
  const chunks: Buffer[] = [];
  let declaredSha: string | null = null;
  const hub = new FileSendHub();
  const reply = (msg: ClientMessage) => {
    const deliver = () => hub.accept(msg, "phone-1");
    if (opts.async) setTimeout(deliver, 0);
    else deliver();
  };
  const send = (msg: ServerMessage) => {
    frames.push(msg as Frame);
    switch (msg.type) {
      case "file_send_start":
        if (opts.abortOnStart !== undefined) {
          reply({ type: "file_send_abort", id: msg.id, code: "no_space", message: opts.abortOnStart });
          return;
        }
        if (opts.ready === false) return;
        reply({ type: "file_send_ready", id: msg.id });
        return;
      case "file_send_chunk": {
        if (opts.abortAtChunk && opts.abortAtChunk.index === msg.index) {
          reply({
            type: "file_send_abort",
            id: msg.id,
            code: "io_error",
            message: opts.abortAtChunk.message,
          });
          return;
        }
        chunks.push(Buffer.from(msg.data, "base64"));
        reply({ type: "file_send_ack", id: msg.id, index: msg.index });
        opts.onAck?.(msg.index);
        return;
      }
      case "file_send_end":
        declaredSha = msg.sha256;
        if (opts.verifyHash === false || sha256(Buffer.concat(chunks)) === msg.sha256) {
          if (opts.verifyHash === false) {
            reply({ type: "file_send_abort", id: msg.id, code: "hash_mismatch", message: "sha256 mismatch" });
            return;
          }
          reply({ type: "file_send_complete", id: msg.id });
        } else {
          reply({ type: "file_send_abort", id: msg.id, code: "hash_mismatch", message: "sha256 mismatch" });
        }
        return;
      default:
        return;
    }
  };
  return { frames, chunks, hub, send, sha: () => declaredSha };
}

function req(path: string, extra: Partial<{ note: string; id: string; size: number }> = {}) {
  const size = extra.size ?? readFileSync(path).length;
  return {
    id: extra.id ?? "att_tc-1",
    path,
    name: "file.bin",
    mime: "application/octet-stream",
    size,
    ...(extra.note !== undefined ? { note: extra.note } : {}),
  };
}

describe("sendFileChunked", () => {
  test("streams the file in 2 MiB chunks, in order, with a matching sha256", async () => {
    const bytes = Buffer.alloc(FILE_SEND_CHUNK_BYTES * 2 + 512, 7);
    const path = write("big.bin", bytes);
    const phone = makePhone({});

    const result = await sendFileChunked(req(path, { note: "here you go" }), {
      hub: phone.hub,
      send: phone.send,
      ownerPeerId: "phone-1",
    });

    expect(result).toMatchObject({ ok: true, chunks: 3, bytes: bytes.length });
    const [start, ...rest] = phone.frames;
    expect(start).toMatchObject({
      type: "file_send_start",
      id: "att_tc-1",
      name: "file.bin",
      path,
      mime: "application/octet-stream",
      size: bytes.length,
      note: "here you go",
    });
    // Chunks first, the end frame last.
    const chunkFrames = rest.filter((f) => f.type === "file_send_chunk");
    expect(chunkFrames.map((f) => (f as { index: number }).index)).toEqual([0, 1, 2]);
    expect(rest.at(-1)?.type).toBe("file_send_end");
    expect(Buffer.concat(phone.chunks).equals(bytes)).toBe(true);
    expect(phone.sha()).toBe(sha256(bytes));
  });

  test("acks may arrive asynchronously, one chunk in flight at a time", async () => {
    const bytes = Buffer.alloc(FILE_SEND_CHUNK_BYTES + 16, 3);
    const path = write("async.bin", bytes);
    // The app answers on a later task, like a real transport: chunk N+1 must
    // not be written before the ack for chunk N came back.
    let acks = 0;
    const phone = makePhone({ async: true, onAck: () => { acks += 1; } });
    const result = await sendFileChunked(req(path), {
      hub: phone.hub,
      ownerPeerId: "phone-1",
      send: (msg) => {
        if (msg.type === "file_send_chunk") expect(acks).toBe(msg.index);
        phone.send(msg);
      },
      timeouts: { ackMs: 500 },
    });
    expect(result.ok).toBe(true);
    expect(phone.frames.filter((f) => f.type === "file_send_chunk")).toHaveLength(2);
    expect(acks).toBe(2);
  });

  test("an app that never accepts the offer is reported as a version problem", async () => {
    const path = write("small.bin", Buffer.alloc(64, 1));
    const phone = makePhone({ ready: false });
    const result = await sendFileChunked(req(path), {
      hub: phone.hub,
      send: phone.send,
      timeouts: { readyMs: 30 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("timeout");
    expect(result.message).toContain("Remote Pi app");
    // Only the offer left the machine; no chunk streamed into a void.
    expect(phone.frames.map((f) => f.type)).toEqual(["file_send_start"]);
  });

  test("a refusal on the offer keeps the phone's own reason", async () => {
    const path = write("small.bin", Buffer.alloc(64, 1));
    const phone = makePhone({ abortOnStart: "not enough space" });
    const result = await sendFileChunked(req(path), { hub: phone.hub, send: phone.send });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("rejected");
    expect(result.message).toContain("not enough space");
  });

  test("a mid-transfer refusal names the chunk's reason and stops the stream", async () => {
    const path = write("mid.bin", Buffer.alloc(FILE_SEND_CHUNK_BYTES * 3, 2));
    const phone = makePhone({ abortAtChunk: { index: 1, message: "disk full" } });
    const result = await sendFileChunked(req(path), { hub: phone.hub, send: phone.send });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("rejected");
    expect(result.message).toContain("disk full");
    expect(phone.frames.filter((f) => f.type === "file_send_chunk")).toHaveLength(2);
  });

  test("a hash mismatch on the phone's side surfaces as its reason", async () => {
    const path = write("hash.bin", Buffer.alloc(128, 5));
    const phone = makePhone({ verifyHash: false });
    const result = await sendFileChunked(req(path), { hub: phone.hub, send: phone.send });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("rejected");
    expect(result.message).toContain("sha256 mismatch");
  });

  test("a file that shrinks mid-transfer fails instead of sending a bad hash", async () => {
    const path = write("shrink.bin", Buffer.alloc(FILE_SEND_CHUNK_BYTES * 2, 9));
    const phone = makePhone({
      onAck: (index) => {
        if (index !== 0) return;
        const fd = openSync(path, "r+");
        ftruncateSync(fd, 100);
        closeSync(fd);
      },
    });
    const result = await sendFileChunked(req(path), { hub: phone.hub, send: phone.send });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("internal_error");
    expect(result.message).toContain("changed");
  });

  test("an empty, missing or over-cap file is refused before any frame", async () => {
    const phone = makePhone({});
    const empty = await sendFileChunked(req(write("empty.bin", "")), { hub: phone.hub, send: phone.send });
    expect(empty.ok === false && empty.code).toBe("rejected");

    const missing = await sendFileChunked(req(join(dir, "nope.bin"), { size: 10 }), { hub: phone.hub, send: phone.send });
    expect(missing.ok === false && missing.code).toBe("not_found");

    // Sparse file: a 250 MiB test fixture must not cost 250 MiB of disk.
    const huge = join(dir, "huge.bin");
    const fd = openSync(huge, "w");
    ftruncateSync(fd, FILE_SEND_MAX_BYTES + 1);
    closeSync(fd);
    const tooBig = await sendFileChunked(req(huge, { size: FILE_SEND_MAX_BYTES + 1 }), { hub: phone.hub, send: phone.send });
    expect(tooBig.ok === false && tooBig.code).toBe("too_large");
    if (tooBig.ok) return;
    expect(tooBig.message).toContain("250 MiB");

    expect(phone.frames).toHaveLength(0);
  });

  test("the hub forgets the transfer when it finishes, so a late frame is inert", async () => {
    const path = write("late.bin", Buffer.alloc(32, 4));
    const phone = makePhone({});
    await sendFileChunked(req(path), { hub: phone.hub, send: phone.send });
    expect(phone.hub.isOpen("att_tc-1")).toBe(false);
    expect(phone.hub.accept({ type: "file_send_ack", id: "att_tc-1", index: 0 }, "phone-1")).toBe(false);
  });
});

describe("FileSendHub", () => {
  test("a different peer cannot ack or abort someone else's transfer", async () => {
    const hub = new FileSendHub();
    hub.open("att_x", "owner");
    expect(hub.accept({ type: "file_send_ready", id: "att_x" }, "intruder")).toBe(true);
    // Dropped, not queued: the owner's wait must still time out.
    const signal = await hub.take("att_x", (s) => s.type === "ready", 20);
    expect(signal).toBeNull();

    hub.accept({ type: "file_send_ready", id: "att_x" }, "owner");
    expect(await hub.take("att_x", (s) => s.type === "ready", 20)).toEqual({ type: "ready" });
  });

  test("signals that arrive before a waiter are queued, in order", async () => {
    const hub = new FileSendHub();
    hub.open("att_y", "owner");
    hub.accept({ type: "file_send_ack", id: "att_y", index: 0 }, "owner");
    hub.accept({ type: "file_send_ack", id: "att_y", index: 1 }, "owner");
    expect(await hub.take("att_y", (s) => s.type === "ack" && s.index === 1, 20)).toEqual({
      type: "ack",
      index: 1,
    });
    expect(await hub.take("att_y", (s) => s.type === "ack", 20)).toEqual({ type: "ack", index: 0 });
  });

  test("a frame for an unknown transfer is not consumed", () => {
    const hub = new FileSendHub();
    expect(hub.accept({ type: "file_send_ack", id: "att_none", index: 0 }, "owner")).toBe(false);
    expect(hub.accept({ type: "ping", id: "p1" }, "owner")).toBe(false);
  });
});
