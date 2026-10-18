import type { ServerMessage } from "./protocol/types.js";
export interface TodoBridge {
    /**
     * Rescan the session branch and broadcast when the visible list changed.
     *
     * Incremental — only entries appended since the last scan are inspected — so
     * it is cheap enough to call after every tool result. Broadcasting is gated on
     * an actual change, so a room with no todo activity stays quiet.
     */
    refresh(ctx: unknown): void;
    /**
     * Forget the scan cursor and the remembered list (the session is being
     * replaced: `/new`, `/resume`, `/fork`). Does not broadcast — the caller
     * follows with [publish] or a fresh [refresh].
     */
    reset(): void;
    /** Broadcast the remembered list as-is (after [reset]: the empty one). */
    publish(): void;
    /** The remembered frame, for `session_sync` replay. */
    current(): ServerMessage;
}
/**
 * Reads the last `rpiv-todo-state` snapshot on the branch and keeps a wire
 * frame in sync with it.
 *
 * `broadcast` is the host's fan-out to attached owners; the bridge itself holds
 * no subscriptions, so there is nothing to dispose.
 */
export declare function createTodoBridge(broadcast: (msg: ServerMessage) => void): TodoBridge;
