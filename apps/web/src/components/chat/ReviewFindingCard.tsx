import { useAtomValue } from "@effect/atom-react";
import {
  REVIEW_FINDING_SEVERITY_LABELS,
  reviewFindingActions,
  reviewFindingFailureMessage,
  reviewFindingLocation,
  reviewFindingPostedLabel,
  type ReviewFindingItem,
} from "@t3tools/client-runtime/review-finding";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  REVIEW_FINDING_COMMENT_MAX_CHARS,
  type EnvironmentId,
  type MessageId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2ReviewFindingSeverity,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { CheckIcon, MessageSquareIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { useRef, useState, type ComponentProps, type MouseEvent } from "react";

import { newMessageId } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import ChatMarkdown from "../ChatMarkdown";
import { isCommentSubmitShortcut } from "../diffs/commentSubmitShortcut";
import { Badge } from "../ui/badge";
import { Button, InlineButton } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { WorkLogRow } from "./WorkLog";

const SEVERITY_BADGE_VARIANTS = {
  critical: "error",
  major: "warning",
  minor: "info",
  nit: "outline",
} as const satisfies Record<
  OrchestrationV2ReviewFindingSeverity,
  ComponentProps<typeof Badge>["variant"]
>;

export function ReviewFindingCard(props: {
  readonly environmentId: EnvironmentId;
  readonly item: ReviewFindingItem;
  readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
  readonly markdownCwd: string | undefined;
  readonly threadRef: ScopedThreadRef | null;
  readonly onOpenPullRequest: (event: MouseEvent<HTMLElement>, url: string) => void;
}) {
  const { environmentId, item } = props;
  const setStatus = useAtomCommand(serverEnvironment.setReviewFindingStatus, {
    label: "update review finding",
    reportFailure: false,
  });
  const post = useAtomCommand(serverEnvironment.postReviewFinding, {
    label: "post review finding",
    reportFailure: false,
  });
  const comment = useAtomCommand(serverEnvironment.commentOnReviewFinding, {
    label: "comment on review finding",
    reportFailure: false,
  });
  const canSetStatus = useAtomValue(
    serverEnvironment.setReviewFindingStatus.permissionAtom(environmentId),
  );
  const canPost = useAtomValue(serverEnvironment.postReviewFinding.permissionAtom(environmentId));
  const canComment = useAtomValue(
    serverEnvironment.commentOnReviewFinding.permissionAtom(environmentId),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [draft, setDraft] = useState("");
  // A shortcut then a click can both run before a re-render; this guard is synchronous.
  const inFlight = useRef(false);
  // The id lives with the draft so a retry after a lost response cannot send the comment twice.
  const draftMessageId = useRef<MessageId | null>(null);

  const actions = reviewFindingActions(item, props.visibility);
  const location = reviewFindingLocation(item);
  const postedLabel = reviewFindingPostedLabel(item);
  const target = { threadId: item.threadId, turnItemId: item.id };

  const run = async <A, E>(execute: () => Promise<AtomCommandResult<A, E>>) => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const result = await execute().finally(() => {
      inFlight.current = false;
      setBusy(false);
    });
    if (result._tag === "Success") return true;
    if (!isAtomCommandInterrupted(result)) {
      setError(reviewFindingFailureMessage(squashAtomCommandFailure(result)));
    }
    return false;
  };

  const updateStatus = (status: "open" | "dismissed") =>
    void run(() => setStatus({ environmentId, input: { ...target, status } }));

  const closeComposer = () => {
    setComposerOpen(false);
    setDraft("");
    draftMessageId.current = null;
  };

  const sendComment = async () => {
    const text = draft.trim();
    if (text.length === 0) return;
    draftMessageId.current ??= newMessageId();
    const messageId = draftMessageId.current;
    const sent = await run(() =>
      comment({
        environmentId,
        input: { ...target, messageId, text, creationSource: "web" },
      }),
    );
    if (sent) closeComposer();
  };

  const errorText =
    error !== null ? (
      <p role="alert" className="text-xs text-destructive">
        {error}
      </p>
    ) : null;

  if (item.findingStatus === "dismissed") {
    return (
      <WorkLogRow
        data-v2-item-type={item.type}
        icon={<XIcon className="size-3.5 text-icon-muted" aria-hidden />}
        label={
          <>
            Dismissed · {item.title}
            {location !== null ? <span className="font-mono"> · {location}</span> : null}
          </>
        }
        trailing={
          actions.restore ? (
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={busy || !canSetStatus}
              onClick={() => updateStatus("open")}
            >
              <RotateCcwIcon aria-hidden />
              Restore
            </Button>
          ) : null
        }
      >
        {errorText}
      </WorkLogRow>
    );
  }

  const showFooter = postedLabel !== null || actions.post || actions.dismiss || actions.comment;

  return (
    <div
      data-v2-item-type={item.type}
      className="flex min-w-0 flex-col gap-2 rounded-xl border border-border/60 bg-card p-3"
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex min-w-0 items-start gap-2">
          {item.severity !== undefined ? (
            <Badge size="sm" variant={SEVERITY_BADGE_VARIANTS[item.severity]} className="mt-0.5">
              {REVIEW_FINDING_SEVERITY_LABELS[item.severity]}
            </Badge>
          ) : null}
          <p className="min-w-0 flex-1 text-sm font-medium text-foreground">{item.title}</p>
        </div>
        {location !== null ? (
          <p className="truncate font-mono text-xs text-muted-foreground">{location}</p>
        ) : null}
      </div>
      {item.body.trim().length > 0 ? (
        <ChatMarkdown
          text={item.body}
          cwd={props.markdownCwd}
          threadRef={props.threadRef ?? undefined}
        />
      ) : null}
      {showFooter ? (
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-1">
          {postedLabel !== null ? (
            <InlineButton
              tone="muted"
              className="me-auto"
              render={<a href={item.pullRequest.url} target="_blank" rel="noreferrer" />}
              onClick={(event) => props.onOpenPullRequest(event, item.pullRequest.url)}
            >
              <CheckIcon className="size-3.5 text-success" aria-hidden />
              {postedLabel}
            </InlineButton>
          ) : null}
          {actions.dismiss ? (
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={busy || !canSetStatus}
              onClick={() => updateStatus("dismissed")}
            >
              <XIcon aria-hidden />
              Dismiss
            </Button>
          ) : null}
          {actions.comment ? (
            <Button
              size="xs"
              variant="ghost"
              aria-expanded={composerOpen}
              disabled={busy || !canComment}
              onClick={() => (composerOpen ? closeComposer() : setComposerOpen(true))}
            >
              <MessageSquareIcon aria-hidden />
              Comment
            </Button>
          ) : null}
          {actions.post ? (
            <Button
              size="xs"
              variant="outline"
              title={`Post to pull request #${item.pullRequest.number}`}
              disabled={busy || !canPost}
              onClick={() => void run(() => post({ environmentId, input: target }))}
            >
              <CheckIcon aria-hidden />
              Post
            </Button>
          ) : null}
        </div>
      ) : null}
      {composerOpen && actions.comment ? (
        <div className="flex min-w-0 flex-col gap-1.5">
          <Textarea
            size="sm"
            autoFocus
            value={draft}
            maxLength={REVIEW_FINDING_COMMENT_MAX_CHARS}
            placeholder="Reply to the agent about this finding"
            aria-label={`Comment on finding: ${item.title}`}
            disabled={busy}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                closeComposer();
              }
              if (isCommentSubmitShortcut(event, draft, busy)) {
                event.preventDefault();
                void sendComment();
              }
            }}
          />
          <div className="flex min-w-0 items-center gap-1">
            <span className="me-auto text-3xs text-muted-foreground/70">⌘/Ctrl Enter to send</span>
            <Button size="xs" variant="ghost-muted" disabled={busy} onClick={closeComposer}>
              Cancel
            </Button>
            <Button
              size="xs"
              disabled={busy || !canComment || draft.trim().length === 0}
              onClick={() => void sendComment()}
            >
              Send
            </Button>
          </div>
        </div>
      ) : null}
      {errorText}
    </div>
  );
}
