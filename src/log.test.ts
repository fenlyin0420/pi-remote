import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { logDiag } from "./log.js";

let priorIsTTY: PropertyDescriptor | undefined;
let write: ReturnType<typeof vi.spyOn<typeof process.stderr, "write">>;

function setStderrIsTTY(value: boolean): void {
	Object.defineProperty(process.stderr, "isTTY", { value, configurable: true });
}

describe("logDiag", () => {
	beforeEach(() => {
		priorIsTTY = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
		write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		write.mockRestore();
		if (priorIsTTY) Object.defineProperty(process.stderr, "isTTY", priorIsTTY);
		else Reflect.deleteProperty(process.stderr, "isTTY");
	});

	test("stays silent on a terminal so it cannot corrupt the Pi TUI frame", () => {
		setStderrIsTTY(true);
		logDiag("[remote-pi] session_history: 4/4 events, 1 KB, truncated=false");
		expect(write).not.toHaveBeenCalled();
	});

	test("writes to a piped stderr (daemon / supervisor journal)", () => {
		setStderrIsTTY(false);
		logDiag("[remote-pi] session_history: 4/4 events, 1 KB, truncated=false");
		expect(write).toHaveBeenCalledWith("[remote-pi] session_history: 4/4 events, 1 KB, truncated=false\n");
	});

	test("adds exactly one trailing newline", () => {
		setStderrIsTTY(false);
		logDiag("a");
		logDiag("b\n");
		expect(write.mock.calls.map((c) => String(c[0]))).toEqual(["a\n", "b\n"]);
	});
});
