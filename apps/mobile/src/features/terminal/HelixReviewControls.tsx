import type {
  HelixReviewAction,
  HelixReviewState,
} from "@t3tools/client-runtime/helix-review-control";
import { Platform, ScrollView, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  ComposerToolbarButton,
  ComposerToolbarRow,
  ComposerToolbarScroller,
} from "../../components/ComposerToolbar";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Sheet } from "../../components/ui/Sheet";
import { helixReviewToolbar } from "./helixReviewToolbar";

export function HelixReviewToolbar(props: {
  ready: boolean;
  state: HelixReviewState | null;
  reviewCount: number;
  canDiscover: boolean;
  onDiscover: () => void;
  busy: boolean;
  canRetry: boolean;
  onRetry: () => void;
  message: string | null;
  onAction: (action: HelixReviewAction) => void;
}) {
  const { actions, progress } = helixReviewToolbar(
    props.ready ? props.state : null,
    props.reviewCount,
  );
  return (
    <View className="border-t border-border bg-card-alt">
      <ComposerToolbarRow paddingBottom={4} paddingHorizontal={8} paddingTop={4}>
        {actions
          .filter(({ action }) => action === "comment" || action === "pr-comment")
          .map(({ action, label, description }) => (
            <ComposerToolbarButton
              key={action}
              label={label}
              accessibilityLabel={description}
              disabled={!props.ready || props.busy || props.canRetry}
              onPress={() => props.onAction(action)}
              showChevron={false}
              minWidth={48}
              textTransform="none"
            />
          ))}
        <ComposerToolbarScroller>
          {actions
            .filter(({ action }) => action !== "comment" && action !== "pr-comment")
            .map(({ action, label, description }) => (
              <ComposerToolbarButton
                key={action}
                label={label}
                accessibilityLabel={description}
                disabled={!props.ready || props.busy || props.canRetry}
                onPress={() => props.onAction(action)}
                showChevron={false}
                minWidth={48}
                textTransform="none"
              />
            ))}
        </ComposerToolbarScroller>
      </ComposerToolbarRow>
      {progress ? (
        <Text className="px-4 pb-2 text-sm text-foreground-muted" accessibilityLiveRegion="polite">
          {progress}
        </Text>
      ) : null}
      {props.message || !props.ready ? (
        <Text className="px-4 pb-2 text-sm text-foreground-muted" accessibilityLiveRegion="polite">
          {props.message ??
            "Waiting for HX. Open Review in HX from the thread’s Terminal menu if it has closed."}
        </Text>
      ) : null}
      {!props.ready && props.canDiscover ? (
        <Button label="Retry HX controls" tone="text" onPress={props.onDiscover} />
      ) : null}
      {props.ready && props.canRetry ? (
        <Button
          label="Retry previous action"
          tone="text"
          disabled={props.busy}
          onPress={props.onRetry}
        />
      ) : null}
    </View>
  );
}

export function HelixReviewPromptSheet(props: {
  action: "ask" | "send" | "comment";
  threadTitle: string;
  text: string;
  busy: boolean;
  isCurrent: boolean;
  error: string | null;
  onChangeText: (text: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const insets = useSafeAreaInsets();
  const asking = props.action === "ask";
  const commenting = props.action === "comment";
  return (
    <Sheet
      title={asking ? "Ask about selection" : commenting ? "Comment for agent" : "Send to agent"}
      onClose={props.onClose}
    >
      <KeyboardAvoidingView automaticOffset behavior="padding" style={{ flex: 1 }}>
        <ScrollView
          className="flex-1"
          keyboardShouldPersistTaps="handled"
          contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
          contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 16, paddingBottom: 20 }}
        >
          <Text className="pb-2 text-sm text-foreground-muted">{props.threadTitle}</Text>
          <Text className="pb-4 text-sm text-foreground-muted">
            {asking
              ? "Your question includes the selection in HX, including old diff text."
              : commenting
                ? "Save feedback on the selection in HX. Send to agent submits your saved comments."
                : "Send pending feedback and saved edits to the agent. Add a note if you like."}
          </Text>
          <TextInput
            autoFocus
            multiline
            editable={!props.busy}
            textAlignVertical="top"
            accessibilityLabel={asking ? "Question about selection" : "Review note"}
            placeholder={
              asking || commenting ? "What should the agent look at?" : "Optional note to the agent"
            }
            value={props.text}
            onChangeText={props.onChangeText}
            className="min-h-36 rounded-xl border border-border bg-card px-3 py-3 text-base text-foreground"
          />
          {props.error || !props.isCurrent ? (
            <Text className="pt-3 text-sm text-foreground-muted" accessibilityLiveRegion="polite">
              {props.error ??
                "This session changed or disconnected. Your draft is still here; reconnect to the same session or copy it before closing."}
            </Text>
          ) : null}
        </ScrollView>
        <View
          className="flex-row gap-3 border-t border-border px-5 pt-3"
          style={{ paddingBottom: Math.max(insets.bottom, 16) }}
        >
          <Button label="Cancel" tone="text" onPress={props.onClose} />
          <View className="flex-1" />
          <Button
            label={
              props.busy
                ? "Waiting for HX…"
                : asking
                  ? "Ask"
                  : commenting
                    ? "Save comment"
                    : "Send to agent"
            }
            tone="primary"
            disabled={
              props.busy || !props.isCurrent || ((asking || commenting) && !props.text.trim())
            }
            onPress={props.onSubmit}
          />
        </View>
      </KeyboardAvoidingView>
    </Sheet>
  );
}
