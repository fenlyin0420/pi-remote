import type { LocalConfig } from "./local_config.js";
/**
 * Pi SDK UI surface needed by the wizard. Subset of `ExtensionUIContext` —
 * declared inline so tests can mock cleanly without dragging the full
 * ExtensionContext shape.
 */
export interface WizardUI {
    /** Picker. Returns the picked option, or undefined if cancelled. */
    select: (title: string, options: string[]) => Promise<string | undefined>;
    /** Non-blocking notification. Used for inline validation feedback. */
    notify?: (msg: string, kind: "info" | "warning" | "error") => void;
}
export interface WizardDefaults {
    agent_name: string;
    use_relay: boolean;
}
/**
 * Runs the setup wizard. Returns the chosen config on confirm, or null when
 * the user cancels the relay question or the final confirmation.
 *
 * Prompts:
 *   1. Use the relay on this terminal? (yes/no) — gates connection to the
 *      remote mesh (mobile devices + other PCs over the relay). "No" means
 *      local-only: this Pi joins the UDS mesh but doesn't open WSS.
 *   Final: review + confirm "Save and activate?" yes/no
 *
 * The agent name is never asked: identity is `(cwd, name)` and the name
 * defaults to the folder leaf (`defaultAgentName`), so setup stays one real
 * question. Renaming is an explicit opt-in (`/remote-pi rename`).
 *
 * Daemon mode (run agents 24/7 via systemd/launchd) is intentionally NOT in
 * the wizard — it's an explicit, separate opt-in via `/remote-pi install`.
 *
 * The local UDS mesh is always single per machine ("local" session) — no
 * session question. All Pis on the same machine see each other through
 * the same broker.
 */
export declare function runSetupWizard(ui: WizardUI, defaults: WizardDefaults): Promise<LocalConfig | null>;
