// Pi → App chunked file push (`send_to_phone` / `file_get` for anything that
// does not fit one envelope).
//
// Why this exists: the relay caps an outer envelope at 4 MiB of `ct`, which is
// Base64 of the inner JSON, which itself carries Base64 of the bytes — so a
// single frame tops out near 2 MiB (see `ATTACHMENT_MAX_BYTES` in
// `session/attachment.ts`). Images are downscaled into that budget and text is
// capped at 1 MiB, but a PDF, an archive or a 40 MB video has no such escape.
// So the file is streamed instead: `file_send_start` → `file_send_chunk` ×N →
// `file_send_end`, exactly the mirror of the app's `upload_*` flow.
//
// Backpressure is the ack, not the socket: one 2 MiB chunk in flight at a time,
// the next one only after the app confirmed the previous. `PlainPeerChannel.send`
// resolves when the frame is written to the relay socket, which says nothing
// about the phone having room for it — a 250 MiB file pushed at full speed would
// land in the relay's and the app's buffers. The ack also gives the transfer
// something to time out on, so a phone that walks away fails the tool call
// instead of leaving it hanging.
import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { basename } from "node:path";
import { logDiag } from "../log.js";
/** Hard per-file ceiling, mirrored by the app's own picker/limits. */
export const FILE_SEND_MAX_BYTES = 250 * 1024 * 1024;
/** Bytes per chunk: base64 → ~2.7 MiB of inner JSON → `ct` ≈ 3.7 MiB < 4 MiB. */
export const FILE_SEND_CHUNK_BYTES = 2 * 1024 * 1024;
/** How long the app may take to accept the offer (`file_send_ready`). */
export const FILE_SEND_READY_TIMEOUT_MS = 20_000;
/** How long one chunk may take to be acknowledged. 2 MiB in 120 s is a
 *  17 KB/s floor — below any usable link, so this only fires on a dead one. */
export const FILE_SEND_ACK_TIMEOUT_MS = 120_000;
/** How long the app may spend verifying + storing the finished file. */
export const FILE_SEND_COMPLETE_TIMEOUT_MS = 120_000;
const SIGNAL_TYPES = new Set([
    "file_send_ready",
    "file_send_ack",
    "file_send_complete",
    "file_send_abort",
]);
/**
 * Waits for the app's answers to a chunked push. One open transfer per card id;
 * the sender is strictly sequential, so a single pending waiter is enough.
 */
export class FileSendHub {
    _open = new Map();
    /** Register a transfer before the first frame goes out. */
    open(id, ownerPeerId) {
        this._open.set(id, { id, ownerPeerId, queue: [] });
    }
    close(id) {
        this._open.delete(id);
    }
    /** True while `id` has a live transfer (used to refuse a second `file_get`
     *  for the same card while its bytes are still in flight). */
    isOpen(id) {
        return this._open.has(id);
    }
    /**
     * Route one app frame to the waiting transfer. Returns true when the frame
     * belonged to an open transfer — including the case where it came from the
     * wrong peer and was deliberately dropped, so the caller does not also
     * treat it as an unrelated `file_get`-era frame.
     */
    accept(msg, peerId) {
        if (!SIGNAL_TYPES.has(msg.type))
            return false;
        const frame = msg;
        if (typeof frame.id !== "string")
            return false;
        const transfer = this._open.get(frame.id);
        if (!transfer)
            return false;
        if (transfer.ownerPeerId !== undefined &&
            peerId !== undefined &&
            transfer.ownerPeerId !== peerId) {
            // Another paired device must not ack (or abort) a transfer it was never
            // offered; dropping it leaves the real owner's stream untouched.
            logDiag(`[remote-pi] file_send ${frame.id}: ignored ${msg.type} from a non-owner peer`);
            return true;
        }
        const signal = _signalOf(msg);
        if (!signal)
            return true;
        if (transfer.waiter) {
            const waiter = transfer.waiter;
            transfer.waiter = undefined;
            waiter(signal);
        }
        else {
            transfer.queue.push(signal);
        }
        return true;
    }
    /** The next queued signal matching `match`, or null when `timeoutMs` passes. */
    take(id, match, timeoutMs) {
        const transfer = this._open.get(id);
        if (!transfer)
            return Promise.resolve(null);
        const at = transfer.queue.findIndex(match);
        if (at >= 0)
            return Promise.resolve(transfer.queue.splice(at, 1)[0]);
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                if (transfer.waiter === waiter)
                    transfer.waiter = undefined;
                resolve(null);
            }, timeoutMs);
            timer.unref?.();
            const waiter = (signal) => {
                clearTimeout(timer);
                resolve(signal);
            };
            transfer.waiter = waiter;
        });
    }
}
function _signalOf(msg) {
    switch (msg.type) {
        case "file_send_ready":
            return { type: "ready" };
        case "file_send_ack":
            return { type: "ack", index: msg.index };
        case "file_send_complete":
            return { type: "complete" };
        case "file_send_abort":
            return { type: "abort", code: msg.code, message: msg.message };
        default:
            return null;
    }
}
/** Read exactly `length` bytes at `offset`, looping over short reads. Reads
 *  fewer only at end of file. */
function _readFully(fd, buffer, length, offset) {
    let filled = 0;
    while (filled < length) {
        const read = readSync(fd, buffer, filled, length - filled, offset + filled);
        if (read <= 0)
            break;
        filled += read;
    }
    return filled;
}
const _fail = (code, message) => ({ ok: false, code, message });
/**
 * Stream one file to the phone. Never throws: every failure (missing file, a
 * phone that never answers, a refusal, a dead transport) comes back typed so
 * the tool can hand the model a message it can act on.
 */
export async function sendFileChunked(req, deps) {
    const chunkBytes = deps.timeouts?.chunkBytes ?? FILE_SEND_CHUNK_BYTES;
    const readyMs = deps.timeouts?.readyMs ?? FILE_SEND_READY_TIMEOUT_MS;
    const ackMs = deps.timeouts?.ackMs ?? FILE_SEND_ACK_TIMEOUT_MS;
    const completeMs = deps.timeouts?.completeMs ?? FILE_SEND_COMPLETE_TIMEOUT_MS;
    let size;
    try {
        const st = statSync(req.path);
        if (!st.isFile())
            return _fail("not_found", `Not a regular file: ${req.path}`);
        size = st.size;
    }
    catch (err) {
        return _fail("not_found", `No such file: ${req.path} (${err instanceof Error ? err.message : String(err)})`);
    }
    if (size === 0)
        return _fail("rejected", `${basename(req.path)} is empty — nothing to send.`);
    if (size > FILE_SEND_MAX_BYTES) {
        return _fail("too_large", `${basename(req.path)} is ${size} bytes; the phone channel carries at most ` +
            `${Math.floor(FILE_SEND_MAX_BYTES / (1024 * 1024))} MiB. Share a link instead.`);
    }
    let fd;
    try {
        fd = openSync(req.path, "r");
    }
    catch (err) {
        return _fail("not_found", `Cannot read ${req.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const hub = deps.hub;
    hub.open(req.id, deps.ownerPeerId);
    const started = Date.now();
    let index = 0;
    let sent = 0;
    try {
        deps.send({
            type: "file_send_start",
            id: req.id,
            name: req.name,
            path: req.path,
            mime: req.mime,
            size,
            ...(req.note && req.note.trim() ? { note: req.note.trim() } : {}),
        });
        const ready = await hub.take(req.id, (s) => s.type === "ready" || s.type === "abort", readyMs);
        if (!ready) {
            return _fail("timeout", "The phone did not accept the file transfer. Update the Remote Pi app " +
                "(this needs a version that accepts streamed files) or share a link instead.");
        }
        if (ready.type === "abort") {
            return _fail("rejected", `The phone refused the file: ${ready.message || ready.code}`);
        }
        const hash = createHash("sha256");
        const buffer = Buffer.alloc(chunkBytes);
        for (;;) {
            const read = _readFully(fd, buffer, chunkBytes, sent);
            if (read <= 0)
                break;
            const bytes = read === chunkBytes ? buffer : buffer.subarray(0, read);
            hash.update(bytes);
            deps.send({ type: "file_send_chunk", id: req.id, index, data: bytes.toString("base64") });
            const ack = await hub.take(req.id, (s) => (s.type === "ack" && s.index === index) || s.type === "abort", ackMs);
            if (!ack) {
                return _fail("timeout", `The phone stopped acknowledging ${req.name} after ${sent} of ${size} bytes. ` +
                    "Check the connection and try again.");
            }
            if (ack.type === "abort") {
                return _fail("rejected", `The phone refused ${req.name}: ${ack.message || ack.code}`);
            }
            sent += read;
            index += 1;
        }
        if (sent !== size) {
            // The file shrank (or grew) under us: the hash the app verifies would
            // never match, so say so here instead of letting it fail on the phone.
            return _fail("internal_error", `${req.name} changed while it was being sent (${sent} of ${size} bytes). Try again.`);
        }
        deps.send({ type: "file_send_end", id: req.id, sha256: hash.digest("hex") });
        const complete = await hub.take(req.id, (s) => s.type === "complete" || s.type === "abort", completeMs);
        if (!complete) {
            return _fail("timeout", `The phone did not confirm ${req.name}. Check the connection and try again.`);
        }
        if (complete.type === "abort") {
            return _fail("rejected", `The phone could not store ${req.name}: ${complete.message || complete.code}`);
        }
        logDiag(`[remote-pi] file_send ${req.id} done: ${req.name} (${size} bytes, ${index} chunks, ` +
            `${Date.now() - started} ms)`);
        return { ok: true, chunks: index, bytes: sent };
    }
    catch (err) {
        return _fail("internal_error", `Could not stream ${req.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
    finally {
        hub.close(req.id);
        try {
            closeSync(fd);
        }
        catch { /* already closed */ }
    }
}
//# sourceMappingURL=file_send.js.map