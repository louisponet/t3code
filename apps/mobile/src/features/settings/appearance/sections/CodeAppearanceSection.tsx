import { useAtomSet } from "@effect/atom-react";
import { useCallback } from "react";

import {
  CODE_FONT_SIZE_STEP,
  MAX_CODE_FONT_SIZE,
  MIN_CODE_FONT_SIZE,
} from "../../../../lib/appearancePreferences";
import { SettingsSection } from "../../components/SettingsSection";
import { updateMobilePreferencesAtom } from "../../../../state/preferences";
import { useHelixCodeViewsEnabled } from "../../../terminal/useHelixCodeViewsEnabled";
import { SettingsSwitchRow } from "../../components/SettingsSwitchRow";
import { useAppearancePreferences } from "../AppearancePreferencesProvider";
import {
  AppearancePreviewSeparator,
  CodeAppearancePreview,
} from "../components/AppearancePreviews";
import { FontSizeSliderRow } from "../components/FontSizeSliderRow";

export function CodeAppearanceSection() {
  const { isReady, appearance, setCodeFontSize, setCodeWordBreak } = useAppearancePreferences();
  const custom = appearance.isCodeFontSizeCustom;
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const helixCodeViews = useHelixCodeViewsEnabled();

  const handleToggleCustom = useCallback(
    (enabled: boolean) => {
      setCodeFontSize(enabled ? appearance.codeFontSize : null);
    },
    [appearance.codeFontSize, setCodeFontSize],
  );

  return (
    <SettingsSection title="Code & Diffs">
      <CodeAppearancePreview
        fontSize={appearance.codeFontSize}
        wordBreak={appearance.codeWordBreak}
      />
      <AppearancePreviewSeparator />
      <SettingsSwitchRow
        disabled={!isReady}
        icon="chevron.left.forwardslash.chevron.right"
        label="Custom font size"
        onValueChange={handleToggleCustom}
        value={custom}
      />
      {custom ? (
        <FontSizeSliderRow
          disabled={!isReady}
          icon="textformat.size"
          label="Font size"
          max={MAX_CODE_FONT_SIZE}
          min={MIN_CODE_FONT_SIZE}
          onChange={setCodeFontSize}
          step={CODE_FONT_SIZE_STEP}
          value={appearance.codeFontSize}
          valueLabel={`${appearance.codeFontSize} pt`}
        />
      ) : null}
      <SettingsSwitchRow
        disabled={!isReady}
        icon="text.word.spacing"
        label="Word break"
        onValueChange={setCodeWordBreak}
        value={appearance.codeWordBreak}
      />
      <SettingsSwitchRow
        disabled={!isReady}
        icon="terminal"
        label="Open in Helix"
        subtitle="Open changes, files and pull request code in a Helix editor."
        onValueChange={(value) => savePreferences({ helixCodeViewsEnabled: value })}
        value={helixCodeViews}
      />
    </SettingsSection>
  );
}
