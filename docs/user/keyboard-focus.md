# Keyboard focus

The command palette keeps focus while open. Closing it returns focus to the composer.
While the palette or model picker is open, number shortcuts select its entries instead of
switching threads. Model shortcuts work in Settings as well as the composer.
See [Keybindings](./keybindings.md) to customize these shortcuts.

If you return to typing while a terminal is starting, the composer keeps focus when the terminal
becomes ready. Opening or switching to a terminal explicitly still focuses it.

A focused [terminal tool](./tools.md#keyboard) receives every key, including Esc. Press
`mod+shift+k` to open the command palette, or click outside it to use other shortcuts again.
The desktop app on Windows and Linux has two exceptions: Ctrl+Q stays the
[quit shortcut](./keybindings.md#desktop-quit-shortcut), and holding Ctrl+W sends it only once.
