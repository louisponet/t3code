import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useEffect, useRef } from "react";
import { View } from "react-native";
import { AppBar } from "../../components/ui/AppBar";
import { EmptyState } from "../../components/ui/EmptyState";
import { Button } from "../../components/ui/Button";
import { useEnvironmentPresentation } from "../../state/presentation";
import { useOpenInHelix } from "../terminal/useOpenInHelix";
import { useReviewCacheForThread } from "./reviewState";
import { helixSourceReviewOptions } from "./helixReviewOptions";
import { useReviewSections } from "./useReviewSections";
import { useAdaptiveWorkspacePaneRole } from "../layout/AdaptiveWorkspaceLayout";

type ReviewSheetProps = StaticScreenProps<{
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}>;

export function HelixReviewSheet(props: ReviewSheetProps) {
  useAdaptiveWorkspacePaneRole("inspector");
  const navigation = useNavigation();
  const { environmentId, threadId } = props.route.params;
  const environment = useEnvironmentPresentation(environmentId);
  const reviewCache = useReviewCacheForThread({ environmentId, threadId });
  const {
    error,
    reviewSections,
    selectedSection,
    selectSection,
    isSelectedSectionPending,
    helixComparison,
  } = useReviewSections({
    enabled: environment.presentation?.connection.phase === "connected",
    environmentId,
    threadId,
    reviewCache,
  });
  const helix = useOpenInHelix(environmentId, threadId);
  const launchedScope = useRef<string | null>(null);
  const historical = selectedSection?.kind === "turn";
  const options = historical
    ? helixComparison
      ? {
          baseline: helixComparison.baseline,
          revision: helixComparison.revision,
          worktreePath: helixComparison.cwd,
          ignoreWhitespace: helixComparison.ignoreWhitespace,
          filePaths: helixComparison.filePaths,
        }
      : null
    : selectedSection?.source
      ? helixSourceReviewOptions(selectedSection.source)
      : null;
  const missingBranchBaseline = selectedSection?.kind === "branch-range" && options === null;
  const scopeKey = JSON.stringify([environmentId, threadId, selectedSection?.id, options]);
  useEffect(() => {
    if (
      !helix.available ||
      !options ||
      launchedScope.current === scopeKey ||
      isSelectedSectionPending
    )
      return;
    if (helix.open(options)) launchedScope.current = scopeKey;
  }, [helix, options, scopeKey, isSelectedSectionPending]);
  return (
    <View className="flex-1 bg-sheet">
      <AppBar
        title={selectedSection?.title ?? "Review changes"}
        onBack={() => navigation.goBack()}
        menus={[
          {
            title: "Review comparison",
            icon: "ellipsis",
            items: reviewSections.map((section) => ({
              id: section.id,
              title: section.title,
              selected: selectedSection?.id === section.id,
              onPress: () => selectSection(section.id),
            })),
          },
        ]}
      />
      <EmptyState
        title={
          isSelectedSectionPending
            ? "Loading review…"
            : missingBranchBaseline
              ? "Branch comparison unavailable"
              : historical && !helixComparison
                ? "Historical review unavailable"
                : helix.available
                  ? "Review in Helix"
                  : "Helix unavailable"
        }
        detail={
          error ??
          (missingBranchBaseline
            ? "This server did not provide the resolved merge base for these changes. Update the server to open this comparison in Helix."
            : historical && !helixComparison
              ? "This server did not provide the exact revisions for this review. Update the server to open this historical comparison in Helix."
              : "Open the selected comparison in the thread’s editor.")
        }
      />
      {helix.available && options ? (
        <Button label="Open in Helix" onPress={() => helix.open(options)} />
      ) : null}
    </View>
  );
}
