import { describe, expect, it } from "vite-plus/test";
import { helixLaunchError, helixStartupText, isHelixLaunchAwaitingClose } from "./helixStartup";

describe("Helix launcher output", () => {
  it("distinguishes launcher failures from shell startup output", () => {
    const startup =
      "exec sh -c 'hx-t3 --thread thread-1'\r\nwarning: shell configuration warning\r\n";
    expect(helixLaunchError(startup)).toBeNull();
    expect(
      helixLaunchError(
        `${startup}\u001b[31mhx-t3: HX: error 'review-open': file is outside this worktree\u001b[0m\r\nPress Enter to close this terminal.\r\n`,
      ),
    ).toBe("HX: error 'review-open': file is outside this worktree");
  });
  it("exposes setup errors without leaking OSC protocol or terminal display sequences", () => {
    expect(
      helixStartupText(
        "\u001b[2J\u001b]777;hx-review;secret;abcd\u0007\r\nreview-open: baseline is not in this branch's history\r\nPress Enter to close this terminal.\n",
      ),
    ).toBe(
      "review-open: baseline is not in this branch's history\nPress Enter to close this terminal.",
    );
  });
  it("offers close only for the printed failure prompt, excluding the echoed launcher", () => {
    expect(
      isHelixLaunchAwaitingClose(
        "exec sh -c 'if hx-t3; then printf \"Press Enter to close this terminal.\"; fi'\n",
      ),
    ).toBe(false);
    expect(
      isHelixLaunchAwaitingClose(
        "exec sh -c 'printf failure'\r\n\u001b[31mPress Enter to close this terminal.\u001b[0m\r\n",
      ),
    ).toBe(true);
  });
  it("keeps a bounded tail so long terminal histories cannot fill the error pane", () => {
    expect(
      helixStartupText("old output".repeat(1000) + "Install hx-t3").length,
    ).toBeLessThanOrEqual(4000);
    expect(helixStartupText("old output".repeat(1000) + "Install hx-t3")).toMatch(
      /Install hx-t3$/u,
    );
  });
});
