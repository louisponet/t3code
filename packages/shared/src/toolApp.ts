export const TOOL_APP_ESCAPE_MESSAGE_TYPE = "t3-tool-app:escape";

export function isToolAppEscapeMessage(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { type?: unknown }).type === TOOL_APP_ESCAPE_MESSAGE_TYPE
  );
}

// A sandboxed page cannot dispatch keys into its parent, so it asks for the palette by message.
export function injectToolAppBootstrap(html: string): string {
  const script = `<script>
(() => {
  window.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && (event.code === "KeyK" || event.key === "k" || event.key === "K")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      window.parent.postMessage({ type: ${JSON.stringify(TOOL_APP_ESCAPE_MESSAGE_TYPE)} }, "*");
    }
  }, true);
})();
</script>`;
  const prefix =
    /^\uFEFF?\s*(?:<!doctype[^>]*>\s*)?(?:<html[^>]*>\s*)?(?:<head[^>]*>)?/i.exec(html)?.[0] ?? "";
  return `${prefix}${script}${html.slice(prefix.length)}`;
}
