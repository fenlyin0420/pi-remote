import type { ClientMessage, ServerMessage } from "../protocol/types.js";
/** Hard per-file ceiling, mirrored by the app's own picker/limits. */
export declare const FILE_SEND_MAX_BYTES: number;
/** Bytes per chunk: base64 → ~2.7 MiB of inner JSON → `ct` ≈ 3.7 MiB < 4 MiB. */
export declare const FILE_SEND_CHUNK_BYTES: number;
/** How long the app may take to accept the offer (`file_send_ready`). */
export declare const FILE_SEND_READY_TIMEOUT_MS = 20000;
/** How long one chunk may take to be acknowledged. 2 MiB in 120 s is a
 *  17 KB/s floor — below any usable link, so this only fires on a dead one. */
export declare const FILE_SEND_ACK_TIMEOUT_MS = 120000;
/** How long the app may spend verifying + storing the finished file. */
export declare const FILE_SEND_COMPLETE_TIMEOUT_MS = 120000;
/** One frame the app sends back while a transfer of `id` is open. */
export type FileSendSignal = {
    type: "ready";
} | {
    type: "ack";
    index: number;
} | {
    type: "complete";
} | {
    type: "abort";
    code: string;
    message: string;
};
/**
 * Waits for the app's answers to a chunked push. One open transfer per card id;
 * the sender is strictly sequential, so a single pending waiter is enough.
 */
export declare class FileSendHub {
    private readonly _open;
    /** Register a transfer before the first frame goes out. */
    open(id: string, ownerPeerId?: string): void;
    close(id: string): void;
    /** True while `id` has a live transfer (used to refuse a second `file_get`
     *  for the same card while its bytes are still in flight). */
    isOpen(id: string): boolean;
    /**
     * Route one app frame to the waiting transfer. Returns true when the frame
     * belonged to an open transfer — including the case where it came from the
     * wrong peer and was deliberately dropped, so the caller does not also
     * treat it as an unrelated `file_get`-era frame.
     */
    accept(msg: ClientMessage, peerId?: string): boolean;
    /** The next queued signal matching `match`, or null when `timeoutMs` passes. */
    take(id: string, match: (signal: FileSendSignal) => boolean, timeoutMs: number): Promise<FileSendSignal | null>;
}
export interface FileSendRequest {
    /** Card id (`att_<toolCallId>`, or the `attachment_id` of a `file_get`). */
    id: string;
    /** Absolute path on the Pi. */
    path: string;
    /** Display name (leaf name, no directories). */
    name: string;
    mime: string;
    size: number;
    note?: string;
}
export interface FileSendDeps {
    hub: FileSendHub;
    /** Deliver one frame to the phone that was offered the file. */
    send: (msg: ServerMessage) => void;
    /** Relay peer id of that phone, when known (ownership check). */
    ownerPeerId?: string;
    timeouts?: {
        readyMs?: number;
        ackMs?: number;
        completeMs?: number;
        /** Chunk size override (tests use a small one). */
        chunkBytes?: number;
    };
}
export type FileSendResult = {
    ok: true;
    chunks: number;
    bytes: number;
} | {
    ok: false;
    code: "not_found" | "too_large" | "rejected" | "timeout" | "internal_error";
    message: string;
};
/**
 * Stream one file to the phone. Never throws: every failure (missing file, a
 * phone that never answers, a refusal, a dead transport) comes back typed so
 * the tool can hand the model a message it can act on.
 */
export declare function sendFileChunked(req: FileSendRequest, deps: FileSendDeps): Promise<FileSendResult>;
