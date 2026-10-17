import type {
  HelixReviewAction,
  HelixReviewState,
} from "@t3tools/client-runtime/helix-review-control";

type ToolbarAction = {
  readonly action: HelixReviewAction;
  readonly label: string;
  readonly description: string;
};

export function helixReviewToolbar(state: HelixReviewState | null, reviewCount = 0) {
  const actions: ToolbarAction[] = [
    { action: "files", label: "Files", description: "Open changed files in HX" },
    { action: "previous", label: "Previous", description: "Previous review change" },
    { action: "next", label: "Next", description: "Next review change" },
    ...(state?.canAsk === false
      ? []
      : [{ action: "ask" as const, label: "Ask", description: "Ask about the HX selection" }]),
  ];
  if (state === null || state.canStage) {
    actions.push({ action: "stage", label: "Stage", description: "Stage the current hunk" });
  }
  if (state?.canMarkReviewed && state.reviewed !== null) {
    actions.push(
      state.reviewed
        ? {
            action: "unmark-reviewed",
            label: "Unmark reviewed",
            description: "Mark the current change as unreviewed",
          }
        : {
            action: "mark-reviewed",
            label: "Mark reviewed",
            description:
              "Mark the current change reviewed and advance to the next unreviewed change",
          },
    );
  }
  if (state?.canComment) {
    actions.unshift({
      action: "comment",
      label: "Comment",
      description: "Save feedback on the HX selection for the agent",
    });
  }
  if (state?.pendingCommentCount)
    actions.push({
      action: "discard-last-comment",
      label: "Undo comment",
      description: "Discard the last saved agent comment",
    });
  if (state?.canReviewPr) {
    actions.push(
      {
        action: "pr-comment",
        label: "PR comment",
        description: "Draft a pull request comment on the selected code",
      },
      {
        action: "pr-review",
        label: reviewCount ? `PR review · ${reviewCount}` : "PR review",
        description: "Preview and submit pull request comments and suggestions",
      },
    );
  }
  if (state?.canSend !== false)
    actions.push({
      action: "send",
      label: state?.pendingCommentCount
        ? `Send to agent · ${state.pendingCommentCount}`
        : "Send to agent",
      description: "Send review to this thread",
    });
  return {
    actions,
    progress:
      state && state.totalCount > 0
        ? `${state.reviewedCount}/${state.totalCount} changes reviewed in this file`
        : null,
  };
}
