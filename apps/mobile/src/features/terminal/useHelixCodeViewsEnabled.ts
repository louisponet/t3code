import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom } from "../../state/preferences";

/** False until preferences load, so a screen never starts a Helix editor the user turned off. */
export function useHelixCodeViewsEnabled(): boolean {
  const preferences = useAtomValue(mobilePreferencesAtom);
  return AsyncResult.isSuccess(preferences) && preferences.value.helixCodeViewsEnabled !== false;
}
