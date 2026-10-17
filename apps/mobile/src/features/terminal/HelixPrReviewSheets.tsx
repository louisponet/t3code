import { Linking, Platform, ScrollView, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { Sheet } from "../../components/ui/Sheet";
import { helixPrLineLabel } from "./helixPrReview";
import type { useHelixPrReview } from "./useHelixPrReview";

const verdictLabels = {
  comment: "Comment",
  approve: "Approve",
  "request-changes": "Request changes",
};

export function HelixPrReviewSheets(props: { review: ReturnType<typeof useHelixPrReview> }) {
  const form = props.review;
  const insets = useSafeAreaInsets();
  if (!form.mode) return null;
  const editing = form.editor;
  const snapshot = form.review;
  const frozen = form.preview;
  const frozenItems = frozen
    ? [
        ...frozen.review.comments,
        ...frozen.review.suggestions.filter((suggestion) => suggestion.accepted),
      ]
    : [];
  const outcome = form.submission;
  const title = editing
    ? editing.draftId
      ? "Edit review comment"
      : "Comment on selected code"
    : frozen
      ? "Review preview"
      : form.mode === "comment"
        ? "Comment on selected code"
        : "Pull request review";
  return (
    <Sheet title={title} onClose={form.close}>
      <KeyboardAvoidingView automaticOffset behavior="padding" style={{ flex: 1 }}>
        <ScrollView
          className="flex-1"
          keyboardShouldPersistTaps="handled"
          contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
          contentContainerStyle={{
            paddingHorizontal: 20,
            paddingTop: 16,
            paddingBottom: Math.max(insets.bottom, 20),
          }}
        >
          <View className="gap-4">
            {snapshot ? (
              <View className="gap-1">
                <Text className="text-base font-t3-bold">
                  #{snapshot.pr.number} · {snapshot.pr.title}
                </Text>
                <Text selectable className="font-mono text-xs text-foreground-muted">
                  {snapshot.pr.repo} · head {snapshot.pr.headSha.slice(0, 7)}
                </Text>
              </View>
            ) : null}
            {!form.current ? (
              <Text className="text-sm text-danger-foreground">
                This HX session changed or disconnected. Your draft text is kept; reconnect to the
                same editor to continue.
              </Text>
            ) : null}
            {form.staleHead ? (
              <Text className="text-sm text-danger-foreground">
                The PR head changed. Reopen the current PR in HX before submitting. Your drafts are
                kept.
              </Text>
            ) : null}
            {form.mode === "review" && form.submissionSupported === false && !outcome ? (
              <Text className="text-sm text-danger-foreground">
                This server cannot safely submit HX reviews with a pinned head and line ranges.
                Update the connected server; your drafts stay in HX.
              </Text>
            ) : null}
            {outcome ? (
              <View className="gap-3 rounded-xl border border-border bg-card p-4">
                <Text accessibilityLiveRegion="polite" className="text-base font-t3-bold">
                  {outcome.status === "submitted"
                    ? "Review submitted"
                    : outcome.status === "submitting"
                      ? "Submitting review…"
                      : "Submission not confirmed"}
                </Text>
                <Text className="text-sm text-foreground-muted">
                  {outcome.status === "submitted"
                    ? outcome.cleaned
                      ? "The review was posted and its HX drafts were cleared."
                      : "The review was posted. Sync HX drafts to clear the submitted items; this will not post the review again."
                    : outcome.status === "submitting"
                      ? "Waiting for the pull request host."
                      : "Check the pull request before posting again. HX drafts are kept; submission will not retry automatically."}
                </Text>
                {snapshot ? (
                  <Button
                    label="Open pull request"
                    tone="text"
                    onPress={() => void Linking.openURL(snapshot.pr.url)}
                  />
                ) : null}
                {outcome.status === "submitted" && !outcome.cleaned ? (
                  <Button
                    label="Sync HX drafts"
                    disabled={form.busy || !form.current}
                    onPress={form.syncSubmitted}
                  />
                ) : null}
                {outcome.status === "uncertain" ||
                (outcome.status === "submitted" && outcome.cleaned) ? (
                  <Button
                    label={
                      outcome.status === "uncertain"
                        ? "I checked the PR; start another review"
                        : "Start another review"
                    }
                    disabled={form.busy || !form.current}
                    tone="text"
                    onPress={form.startNew}
                  />
                ) : null}
              </View>
            ) : null}
            {editing && !outcome ? (
              <>
                <View className="gap-2 rounded-xl border border-border bg-card p-4">
                  <Text selectable className="font-mono text-xs text-foreground-muted">
                    {editing.anchor.path} · {helixPrLineLabel(editing.anchor)}
                  </Text>
                  <Text selectable className="font-mono text-xs">
                    {editing.anchor.code}
                  </Text>
                </View>
                <TextInput
                  autoFocus
                  multiline
                  editable={!form.busy && !form.canRetry}
                  textAlignVertical="top"
                  accessibilityLabel="Pull request comment draft"
                  placeholder="Write feedback on this code…"
                  value={editing.body}
                  onChangeText={form.setBody}
                  className="min-h-36 rounded-xl border border-border bg-card px-3 py-3 text-base text-foreground"
                />
                <Text className="text-xs text-foreground-muted">
                  Saved drafts stay in HX until you submit your review. Ask sends a question to the
                  agent.
                </Text>
                <View className="flex-row flex-wrap gap-3">
                  <Button
                    label="Cancel"
                    tone="text"
                    onPress={form.cancelEditor}
                    disabled={form.busy}
                  />
                  <Button
                    label={form.busy ? "Saving…" : "Save draft"}
                    tone="primary"
                    disabled={!form.editable || !editing.body.trim()}
                    onPress={form.save}
                  />
                </View>
              </>
            ) : frozen ? (
              <View className="gap-4">
                <Text className="text-sm font-t3-bold">
                  {verdictLabels[frozen.input.verdict]} · {frozen.input.comments.length} line{" "}
                  {frozen.input.comments.length === 1 ? "comment" : "comments"}
                </Text>
                <Text selectable className="text-sm">
                  {frozen.input.body || "No summary"}
                </Text>
                {frozen.input.comments.map((comment, index) => {
                  const line =
                    comment.position.kind === "deleted"
                      ? comment.position.oldLine
                      : comment.position.newLine;
                  return (
                    <View
                      key={frozenItems[index]!.id}
                      className="gap-2 rounded-xl border border-border bg-card p-4"
                    >
                      <Text selectable className="font-mono text-xs text-foreground-muted">
                        {comment.path} ·{" "}
                        {helixPrLineLabel({
                          side: comment.position.kind === "deleted" ? "LEFT" : "RIGHT",
                          startLine: comment.startLine ?? line,
                          line,
                        })}
                      </Text>
                      <Text selectable className="text-sm">
                        {comment.body}
                      </Text>
                    </View>
                  );
                })}
                {!outcome ? (
                  <>
                    <Text className="text-xs text-foreground-muted">
                      This is the combined review that will be posted at head{" "}
                      {frozen.input.expectedHeadSha.slice(0, 7)}. HX will refresh once more before
                      submission.
                    </Text>
                    <View className="flex-row flex-wrap gap-3">
                      <Button
                        label="Back to drafts"
                        tone="text"
                        disabled={form.busy}
                        onPress={form.backToDrafts}
                      />
                      <Button
                        label={form.busy ? "Submitting…" : "Submit review"}
                        tone="primary"
                        disabled={!form.canPreview}
                        onPress={form.submit}
                      />
                    </View>
                  </>
                ) : null}
              </View>
            ) : form.mode === "review" && snapshot ? (
              <>
                {form.verdicts.length ? (
                  <SegmentedControl
                    options={form.verdicts.map((value) => ({ value, label: verdictLabels[value] }))}
                    selected={form.verdict}
                    onSelect={(value) => {
                      if (form.editable) form.setVerdict(value);
                    }}
                    size="compact"
                  />
                ) : null}
                <Text className="text-sm font-t3-bold">Summary</Text>
                <TextInput
                  multiline
                  editable={!form.busy}
                  textAlignVertical="top"
                  accessibilityLabel="Pull request review summary"
                  placeholder="Summarize your review…"
                  value={form.summary}
                  maxLength={65536}
                  onChangeText={form.setSummary}
                  className="min-h-32 rounded-xl border border-border bg-card px-3 py-3 text-base text-foreground"
                />
                <Text className="text-sm font-t3-bold">
                  Draft comments · {snapshot.comments.length}
                </Text>
                {!snapshot.comments.length ? (
                  <Text className="text-sm text-foreground-muted">
                    Select code in HX and use Comment to add feedback.
                  </Text>
                ) : null}
                {snapshot.comments.map((comment) => (
                  <View
                    key={comment.id}
                    className="gap-2 rounded-xl border border-border bg-card p-4"
                  >
                    <Text selectable className="font-mono text-xs text-foreground-muted">
                      {comment.path} · {helixPrLineLabel(comment)}
                    </Text>
                    <Text selectable className="text-sm">
                      {comment.body}
                    </Text>
                    {comment.replyTo !== undefined ? (
                      <Text className="text-xs text-danger-foreground">
                        Replies cannot be submitted with this review. Remove this draft and reply on
                        the pull request.
                      </Text>
                    ) : null}
                    <View className="flex-row flex-wrap gap-2">
                      <Button
                        label="Edit"
                        tone="text"
                        disabled={!form.editable}
                        onPress={() => form.edit(comment)}
                      />
                      <Button
                        label="Remove"
                        tone="text"
                        disabled={!form.editable}
                        onPress={() => form.remove(comment.id)}
                      />
                    </View>
                  </View>
                ))}
                <Text className="text-sm font-t3-bold">
                  Agent edit suggestions · {snapshot.suggestions.length}
                </Text>
                <Text className="text-xs text-foreground-muted">
                  Include the saved agent edits you want to propose on the pull request. Excluded
                  suggestions will not be posted.
                </Text>
                {snapshot.suggestions.map((suggestion) => (
                  <View
                    key={suggestion.id}
                    className="gap-2 rounded-xl border border-border bg-card p-4"
                  >
                    <Text selectable className="font-mono text-xs text-foreground-muted">
                      {suggestion.path} · {helixPrLineLabel(suggestion)}
                    </Text>
                    <Text className="text-xs font-t3-bold">Original</Text>
                    <Text selectable className="font-mono text-xs">
                      {suggestion.original}
                    </Text>
                    <Text className="text-xs font-t3-bold">Proposed</Text>
                    <Text selectable className="font-mono text-xs">
                      {suggestion.replacement || "Delete these lines"}
                    </Text>
                    {suggestion.error ? (
                      <Text className="text-xs text-danger-foreground">{suggestion.error}</Text>
                    ) : null}
                    <Button
                      label={suggestion.accepted ? "Included · Exclude" : "Include suggestion"}
                      tone={suggestion.accepted ? "secondary" : "text"}
                      disabled={!form.editable || Boolean(suggestion.error)}
                      onPress={() => form.toggleSuggestion(suggestion.id, !suggestion.accepted)}
                    />
                  </View>
                ))}
                <Button
                  label={form.busy ? "Refreshing…" : "Preview review"}
                  tone="primary"
                  disabled={!form.canPreview}
                  onPress={form.preparePreview}
                />
                {!form.verdicts.length && !form.busy ? (
                  <Text className="text-sm text-foreground-muted">
                    Review submission requires an open pull request and permission to review it.
                  </Text>
                ) : null}
              </>
            ) : null}
            {form.error ? (
              <Text
                selectable
                accessibilityLiveRegion="polite"
                className="text-sm text-danger-foreground"
              >
                {form.error}
              </Text>
            ) : null}
            {form.canRetry ? (
              <Button
                label="Retry previous HX action"
                disabled={form.busy || !form.current}
                onPress={form.retry}
              />
            ) : null}
            {!frozen && !outcome ? (
              <Button
                label={editing || form.mode === "comment" ? "Refresh selection" : "Refresh review"}
                tone="text"
                disabled={form.busy || !form.current || form.canRetry}
                onPress={form.refresh}
              />
            ) : null}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Sheet>
  );
}
