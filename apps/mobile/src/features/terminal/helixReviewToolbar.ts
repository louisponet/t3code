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
  const reviewing = state?.mode === "review";
  const actions: ToolbarAction[] = [
    { action: "files", label: "Files", description: "Open changed files in HX" },
    { action: "previous", label: "Previous", description: "Previous review change" },
    { action: "next", label: "Next", description: "Next review change" },
    ...(state?.canAsk === false
      ? []
      : [
          {
            action: "ask" as const,
            label: "Ask agent",
            description: reviewing
              ? "Ask your co-reviewer about the HX selection"
              : "Ask the agent about the HX selection",
          },
        ]),
  ];
  if (!reviewing && (state === null || state.canStage)) {
    actions.push({ action: "stage", label: "Stage", description: "Stage the current hunk" });
  }
  if (reviewing && state?.canMarkReviewed && state.reviewed !== null) {
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
  if (!reviewing && state?.canComment) {
    actions.unshift({
      action: "comment",
      label: "Comment for agent",
      description: "Save feedback on the HX selection for the agent",
    });
  }
  if (!reviewing && state?.pendingCommentCount)
    actions.push({
      action: "discard-last-comment",
      label: "Undo comment",
      description: "Discard the last saved agent comment",
    });
  if (reviewing && state?.canReviewPr) {
    actions.push(
      {
        action: "pr-comment",
        label: "Draft PR comment",
        description: "Draft a pull request comment on the selected code",
      },
      {
        action: "pr-review",
        label: reviewCount ? `Review drafts · ${reviewCount}` : "Review drafts",
        description: "Preview and submit pull request comments and suggestions",
      },
    );
  }
  if (!reviewing && state?.canSend !== false)
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
      reviewing && state && state.totalCount > 0
        ? `${state.reviewedCount}/${state.totalCount} changes reviewed in this file`
        : null,
  };
}
