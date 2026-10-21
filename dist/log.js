/**
 * Diagnostics sink for the extension's own `[remote-pi] …` chatter.
 *
 * The interactive Pi TUI owns the terminal: it repaints differentially against
 * what it painted last, so a stray write lands wherever the hardware cursor
 * happens to sit — in practice over the editor — and the frame stays broken
 * from then on. Headless sessions (supervisor, daemon) send stderr into a
 * journal or a pipe, which is where these lines belong.
 *
 * So: write only when stderr is not a terminal. Anything a user has to see goes
 * through `ctx.ui.notify` / the app. The CLI entry points (`remote-pi …`) keep
 * writing to stderr and stdout directly — they own the terminal by definition.
 */
export function logDiag(text) {
    if (process.stderr.isTTY === true)
        return;
    process.stderr.write(text.endsWith("\n") ? text : `${text}\n`);
}
//# sourceMappingURL=log.js.map