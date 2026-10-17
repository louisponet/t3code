import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

export {
  REVIEW_FINDING_SEVERITY_LABELS,
  reviewFindingLocation,
} from "@t3tools/shared/reviewFinding";

export type ReviewFindingItem = Extract<
  OrchestrationV2TurnItem,
  { readonly type: "review_finding" }
>;

export interface ReviewFindingActions {
  readonly dismiss: boolean;
  readonly restore: boolean;
  readonly post: boolean;
  readonly comment: boolean;
}

const NO_ACTIONS: ReviewFindingActions = {
  dismiss: false,
  restore: false,
  post: false,
  comment: false,
};

/**
 * `visibility` is the projected row's: a finding inherited from another
 * thread (a fork) can only be acted on where it was reported.
 */
export function reviewFindingActions(
  item: Pick<ReviewFindingItem, "findingStatus">,
  visibility: "local" | "inherited" | "synthetic",
): ReviewFindingActions {
  if (visibility !== "local") return NO_ACTIONS;
  switch (item.findingStatus) {
    case "open":
      return { dismiss: true, restore: false, post: true, comment: true };
    case "dismissed":
      return { dismiss: false, restore: true, post: false, comment: true };
    case "posted":
      return { dismiss: false, restore: false, post: false, comment: true };
  }
}

export function reviewFindingPostedLabel(
  item: Pick<ReviewFindingItem, "findingStatus" | "postedAs" | "pullRequest">,
): string | null {
  if (item.findingStatus !== "posted") return null;
  return item.postedAs === "inline"
    ? `Posted inline on #${item.pullRequest.number}`
    : `Posted on #${item.pullRequest.number}`;
}

const USER_FACING_FAILURE_TAGS = new Set(["ReviewFindingError", "EnvironmentAuthorizationError"]);

/**
 * Only known server errors pass their message through: anything else (transport or encoding
 * failures) gets the generic copy.
 */
export function reviewFindingFailureMessage(failure: unknown): string {
  if (
    typeof failure === "object" &&
    failure !== null &&
    "_tag" in failure &&
    typeof failure._tag === "string" &&
    USER_FACING_FAILURE_TAGS.has(failure._tag) &&
    "message" in failure &&
    typeof failure.message === "string" &&
    failure.message.trim().length > 0
  ) {
    return failure.message;
  }
  return "Could not update the finding. Try again.";
}
