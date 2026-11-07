const YES = "Yes";
const NO = "No";
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
export async function runSetupWizard(ui, defaults) {
    const agent_name = defaults.agent_name;
    ui.notify?.("The relay forwards encrypted messages to the Remote Pi mobile app and other PCs in your mesh. Skip this if you only want a local-only mesh on this machine.", "info");
    const useRelayChoice = await ui.select("Use the relay on this terminal to connect to the remote mesh (mobile + PCs)?", defaults.use_relay ? [YES, NO] : [NO, YES]);
    if (!useRelayChoice)
        return null;
    const auto_start_relay = useRelayChoice === YES;
    // Review + confirm
    const summary = [
        `  Agent name:    ${agent_name}`,
        `  Use relay:     ${auto_start_relay ? YES : NO}`,
    ].join("\n");
    ui.notify?.(`Summary:\n${summary}`, "info");
    const confirm = await ui.select("Save and activate?", [YES, NO]);
    if (confirm !== YES)
        return null;
    return { agent_name, auto_start_relay };
}
//# sourceMappingURL=setup_wizard.js.map