import { create } from "zustand";

/**
 * Runtime tab ids (epoch-qualified, since desktop tab ids repeat across server restarts) of the
 * tool tabs this app opened. Another device's desktop tool tab is that device's to render;
 * hosting it here would load the page in the background and race its navigation reports.
 */
export const useLaunchedToolTabs = create<{
  readonly keys: ReadonlySet<string>;
  readonly add: (key: string) => void;
}>((set) => ({
  keys: new Set(),
  add: (key) =>
    set((state) => (state.keys.has(key) ? state : { keys: new Set(state.keys).add(key) })),
}));

export const markToolTabLaunched = (key: string) => useLaunchedToolTabs.getState().add(key);
