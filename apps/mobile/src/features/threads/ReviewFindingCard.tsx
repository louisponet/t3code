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
  MessageId,
  REVIEW_FINDING_COMMENT_MAX_CHARS,
  type EnvironmentId,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import { useRef, useState, type ReactNode } from "react";
import { Pressable, View, type ColorValue } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Chip } from "../../components/ui/Chip";
import { IconButton } from "../../components/ui/IconButton";
import { uuidv4 } from "../../lib/uuid";
import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

export function ReviewFindingCard(props: {
  readonly environmentId: EnvironmentId;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly iconColor: ColorValue;
  readonly renderMarkdown: (markdown: string) => ReactNode;
}) {
  const { item, visibility } = props.projectedItem;
  if (item.type !== "review_finding") return null;
  return (
    <ReviewFinding
      environmentId={props.environmentId}
      item={item}
      visibility={visibility}
      iconColor={props.iconColor}
      renderMarkdown={props.renderMarkdown}
    />
  );
}

function ReviewFinding(props: {
  readonly environmentId: EnvironmentId;
  readonly item: ReviewFindingItem;
  readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
  readonly iconColor: ColorValue;
  readonly renderMarkdown: (markdown: string) => ReactNode;
}) {
  const { environmentId, item } = props;
  // Failures show inside the card, not as a second toast.
  const setStatus = useAtomCommand(serverEnvironment.setReviewFindingStatus, {
    label: "review finding status",
    reportFailure: false,
  });
  const post = useAtomCommand(serverEnvironment.postReviewFinding, {
    label: "post review finding",
    reportFailure: false,
  });
  const comment = useAtomCommand(serverEnvironment.commentOnReviewFinding, {
    label: "review finding comment",
    reportFailure: false,
  });
  const canSetStatus = useAtomValue(
    serverEnvironment.setReviewFindingStatus.permissionAtom(environmentId),
  );
  const canPost = useAtomValue(serverEnvironment.postReviewFinding.permissionAtom(environmentId));
  const canComment = useAtomValue(
    serverEnvironment.commentOnReviewFinding.permissionAtom(environmentId),
  );
  const openPullRequest = useOpenPullRequest();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The id lives with the draft so a retry after a lost response cannot send the comment twice.
  const [draft, setDraft] = useState<{
    readonly messageId: MessageId;
    readonly text: string;
  } | null>(null);
  // A double tap can run twice before a re-render; this guard is synchronous.
  const inFlight = useRef(false);

  const actions = reviewFindingActions(item, props.visibility);
  const target = { threadId: item.threadId, turnItemId: item.id };

  const run = async (execute: () => Promise<AtomCommandResult<unknown, unknown>>) => {
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

  const changeStatus = (status: "open" | "dismissed") =>
    void run(() => setStatus({ environmentId, input: { ...target, status } }));

  const sendComment = async () => {
    const text = draft?.text.trim() ?? "";
    if (draft === null || text.length === 0) return;
    const sent = await run(() =>
      comment({
        environmentId,
        input: { ...target, messageId: draft.messageId, text, creationSource: "mobile" },
      }),
    );
    if (sent) setDraft(null);
  };

  const errorText =
    error !== null ? (
      <Text
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
        className="font-sans text-sm text-danger-foreground"
      >
        {error}
      </Text>
    ) : null;

  if (item.findingStatus === "dismissed") {
    return (
      <View className="mb-3 gap-1 px-1">
        <View className="min-h-9 flex-row items-center gap-2">
          <SymbolView name="xmark" size={13} tintColor={props.iconColor} type="monochrome" />
          <Text className="flex-1 font-sans text-sm text-foreground-muted" numberOfLines={1}>
            Dismissed · {item.title}
          </Text>
          {actions.restore && canSetStatus ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Restore finding"
              accessibilityState={{ disabled: busy }}
              disabled={busy}
              hitSlop={8}
              className="px-1 py-1 active:opacity-60 disabled:opacity-50"
              onPress={() => changeStatus("open")}
            >
              <Text className="font-sans text-xs text-foreground-muted">Restore</Text>
            </Pressable>
          ) : null}
        </View>
        {errorText}
      </View>
    );
  }

  const location = reviewFindingLocation(item);
  const postedLabel = reviewFindingPostedLabel(item);
  const showPost = actions.post && canPost;
  const showComment = actions.comment && canComment && draft === null;
  const showDismiss = actions.dismiss && canSetStatus;

  return (
    <View className="mb-3 gap-3 rounded-[20px] border border-border bg-card-alt p-4">
      <View className="gap-1">
        {item.severity !== undefined ? (
          <View className="mb-1 flex-row">
            <Chip size="small" label={REVIEW_FINDING_SEVERITY_LABELS[item.severity]} />
          </View>
        ) : null}
        <Text selectable className="font-t3-bold text-base text-foreground">
          {item.title}
        </Text>
        {location !== null ? (
          <Text
            selectable
            numberOfLines={1}
            ellipsizeMode="middle"
            className="font-mono text-xs text-foreground-muted"
          >
            {location}
          </Text>
        ) : null}
      </View>
      {item.body.trim().length > 0 ? <View>{props.renderMarkdown(item.body)}</View> : null}
      {draft !== null ? (
        <View className="gap-2">
          <TextInput
            autoFocus
            multiline
            textAlignVertical="top"
            accessibilityLabel="Comment for the agent"
            placeholder="Tell the agent about this finding"
            maxLength={REVIEW_FINDING_COMMENT_MAX_CHARS}
            value={draft.text}
            onChangeText={(text) => setDraft({ ...draft, text })}
            editable={!busy}
            className="min-h-20"
          />
          <View className="flex-row justify-end gap-2">
            <Button
              label="Cancel"
              tone="text"
              disabled={busy}
              onPress={() => {
                setDraft(null);
                setError(null);
              }}
            />
            <Button
              label="Send"
              tone="primary"
              loading={busy}
              disabled={draft.text.trim().length === 0}
              onPress={() => void sendComment()}
            />
          </View>
        </View>
      ) : null}
      {errorText}
      {postedLabel !== null || showPost || showComment || showDismiss ? (
        <View className="flex-row items-center justify-end gap-1">
          {postedLabel !== null ? (
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={`${postedLabel}. Open pull request`}
              hitSlop={8}
              className="flex-1 flex-row items-center gap-1.5 py-1 active:opacity-60"
              onPress={() => void openPullRequest(item.pullRequest.url)}
            >
              <SymbolView
                name="checkmark"
                size={13}
                tintColor={props.iconColor}
                type="monochrome"
              />
              <Text className="shrink font-sans text-sm text-foreground-muted" numberOfLines={1}>
                {postedLabel}
              </Text>
            </Pressable>
          ) : null}
          {showPost ? (
            <IconButton
              accessibilityLabel="Post finding to the pull request"
              icon="checkmark"
              variant="primary"
              disabled={busy}
              onPress={() => void run(() => post({ environmentId, input: target }))}
            />
          ) : null}
          {showComment ? (
            <IconButton
              accessibilityLabel="Comment on finding"
              icon="text.bubble"
              disabled={busy}
              onPress={() => {
                setError(null);
                setDraft({ messageId: MessageId.make(uuidv4()), text: "" });
              }}
            />
          ) : null}
          {showDismiss ? (
            <IconButton
              accessibilityLabel="Dismiss finding"
              icon="xmark"
              disabled={busy}
              onPress={() => changeStatus("dismissed")}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
