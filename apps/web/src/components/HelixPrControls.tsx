import { useLayoutEffect, useRef, useState } from "react";
import type {
  HelixPrReviewPayload,
  HelixPrReviewSnapshot,
  HelixReviewAction,
  HelixReviewMarker,
  HelixReviewTarget,
} from "@t3tools/client-runtime/helix-review-control";
import { EnvironmentId, ProjectId, type PullRequestReviewVerdict } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { useEnvironmentQuery } from "~/state/query";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  helixPrReviewFingerprint,
  helixPrReviewInput,
  helixPrActionText,
} from "./chat/helixPrReview";
import { Button } from "./ui/button";

type Outcome = {
  status: "submitting" | "submitted" | "uncertain";
  revision: string;
  cleaned: boolean;
};
const outcomes = new Map<string, Outcome>();

export function HelixPrControls({
  target,
  projectId,
  markers,
  send,
}: {
  target: HelixReviewTarget;
  projectId: string;
  markers: readonly HelixReviewMarker[];
  send: (action: HelixReviewAction, text?: string) => Promise<string>;
}) {
  const [open, setOpen] = useState(false);
  const [review, setReview] = useState<HelixPrReviewSnapshot | null>(null);
  const [text, setText] = useState("");
  const [summary, setSummary] = useState("");
  const [verdict, setVerdict] = useState<PullRequestReviewVerdict>("comment");
  const [preview, setPreview] = useState<HelixPrReviewSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify([
    target.environmentId,
    target.threadId,
    target.terminalId,
    target.nonce,
  ]);
  const [outcome, setOutcome] = useState(() => outcomes.get(key) ?? null);
  const payloads = useRef(new Map<string, HelixPrReviewPayload>());
  const waiters = useRef(new Map<string, (value: HelixPrReviewPayload) => void>());
  useLayoutEffect(() => {
    for (const marker of markers)
      if (
        marker.nonce === target.nonce &&
        marker.payload.kind === "pr-review" &&
        marker.payload.requestId
      )
        payloads.current.set(marker.payload.requestId, marker.payload);
    for (const [id, resolve] of waiters.current) {
      const payload = payloads.current.get(id);
      if (payload) {
        waiters.current.delete(id);
        resolve(payload);
      }
    }
  }, [markers, target.nonce]);
  const destination = review
    ? {
        environmentId: EnvironmentId.make(target.environmentId),
        input: {
          projectId: ProjectId.make(projectId),
          host: new URL(review.pr.url).host,
          repository: review.pr.repo,
          number: review.pr.number,
        },
      }
    : null;
  const detail = useEnvironmentQuery(
    open && destination ? pullRequestEnvironment.detail(destination) : null,
  );
  const submit = useAtomCommand(pullRequestEnvironment.submitReview, { reportFailure: false });
  async function request(action: HelixReviewAction, value?: unknown) {
    const id = await send(action, value === undefined ? undefined : helixPrActionText(value));
    const payload =
      payloads.current.get(id) ??
      (await new Promise<HelixPrReviewPayload>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.current.delete(id);
          reject(
            new Error("HX did not return its PR review. Refresh to check the current drafts."),
          );
        }, 10000);
        waiters.current.set(id, (value) => {
          clearTimeout(timer);
          resolve(value);
        });
      }));
    if (payload.error || !payload.review)
      throw new Error(payload.error ?? "This editor is not reviewing a pull request.");
    setReview(payload.review);
    return payload.review;
  }
  async function run(operation: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  function remember(value: Outcome) {
    outcomes.set(key, value);
    setOutcome(value);
  }
  const verdicts =
    detail.data?.state === "open"
      ? (detail.data.capabilities.review.verdicts.filter((value) =>
          detail.data?.viewerPermissions.verdicts.includes(value),
        ) ?? [])
      : [];
  const canSubmit =
    detail.data?.capabilities.review.multilineComment === true &&
    review?.pr.headSha === detail.data.headSha &&
    verdicts.includes(verdict);
  async function cleanup(revision: string) {
    await request("pr-complete", { revision });
    remember({ status: "submitted", revision, cleaned: true });
  }
  return (
    <div className="shrink-0 border-t border-border/60 text-xs">
      <div className="flex items-center gap-2 p-1">
        <Button
          size="xs"
          onClick={() => {
            setOpen((value) => !value);
            if (!open) void run(() => request("pr-review"));
          }}
        >
          Review drafts
        </Button>
        {review ? (
          <span>
            {review.comments.length} comments ·{" "}
            {review.suggestions.filter((entry) => entry.accepted).length} suggestions
          </span>
        ) : null}
      </div>
      {open ? (
        <div className="max-h-80 space-y-2 overflow-auto p-2">
          <Button
            size="xs"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await request("pr-review");
                detail.refresh();
                setPreview(null);
              })
            }
          >
            Refresh selection and drafts
          </Button>
          {review?.selection ? (
            <div>
              <p>
                {review.selection.path}:{review.selection.startLine}–{review.selection.line} (
                {review.selection.side})
              </p>
              <pre className="max-h-20 overflow-auto whitespace-pre-wrap">
                {review.selection.code}
              </pre>
              <textarea
                aria-label="PR line comment"
                className="w-full rounded border border-border bg-background p-1"
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
              <Button
                size="xs"
                disabled={busy || !text.trim() || outcome !== null}
                onClick={() =>
                  void run(async () => {
                    await request("pr-comment", {
                      revision: review.revision,
                      selectionId: review.selection!.id,
                      body: text,
                    });
                    setText("");
                    setPreview(null);
                  })
                }
              >
                Save PR comment draft
              </Button>
            </div>
          ) : (
            <p className="text-muted-foreground">
              Select code in Helix, then refresh to add a line comment.
            </p>
          )}
          {review?.comments.map((comment) => (
            <div key={comment.id} className="rounded border border-border p-2">
              <p>
                {comment.path}:{comment.startLine}–{comment.line} ({comment.side})
              </p>
              <p className="whitespace-pre-wrap">{comment.body}</p>
              <Button
                size="xs"
                disabled={busy || outcome !== null}
                onClick={() =>
                  void run(async () => {
                    await request("pr-comment", {
                      revision: review.revision,
                      id: comment.id,
                      body: null,
                    });
                    setPreview(null);
                  })
                }
              >
                Remove comment
              </Button>
            </div>
          ))}
          {review?.suggestions.map((suggestion) => (
            <label key={suggestion.id} className="block rounded border border-border p-2">
              <input
                type="checkbox"
                checked={suggestion.accepted}
                disabled={busy || outcome !== null}
                onChange={(event) =>
                  void run(async () => {
                    await request("pr-suggestion", {
                      revision: review.revision,
                      id: suggestion.id,
                      accepted: event.target.checked,
                    });
                    setPreview(null);
                  })
                }
              />{" "}
              Include suggestion · {suggestion.path}:{suggestion.startLine}–{suggestion.line}
              <pre className="whitespace-pre-wrap">{suggestion.replacement}</pre>
              {suggestion.error ? <p>{suggestion.error}</p> : null}
            </label>
          ))}
          <textarea
            aria-label="PR review summary"
            placeholder="Review summary…"
            className="w-full rounded border border-border bg-background p-1"
            value={summary}
            disabled={outcome !== null}
            onChange={(event) => {
              setSummary(event.target.value);
              setPreview(null);
            }}
          />
          <select
            aria-label="Review verdict"
            value={verdict}
            disabled={outcome !== null}
            onChange={(event) => {
              setVerdict(event.target.value as PullRequestReviewVerdict);
              setPreview(null);
            }}
          >
            {verdicts.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          {outcome ? (
            <div role="status">
              <p>
                {outcome.status === "uncertain"
                  ? "Submission could not be confirmed. Check the PR before posting again; drafts are kept in HX."
                  : outcome.status === "submitting"
                    ? "Submitting review…"
                    : "Review submitted."}
              </p>
              {outcome.status !== "submitting" &&
              (outcome.status === "uncertain" || outcome.cleaned) ? (
                <Button
                  size="xs"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      outcomes.delete(key);
                      setOutcome(null);
                      setPreview(null);
                      setSummary("");
                      await request("pr-review");
                    })
                  }
                >
                  {outcome.status === "uncertain"
                    ? "I checked the PR; start a new review"
                    : "Start another review"}
                </Button>
              ) : null}
              {outcome.status === "submitted" && !outcome.cleaned ? (
                <Button
                  size="xs"
                  disabled={busy}
                  onClick={() => void run(() => cleanup(outcome.revision))}
                >
                  Sync submitted drafts
                </Button>
              ) : null}
            </div>
          ) : preview ? (
            <div className="space-y-2 rounded border border-border p-2">
              <p>
                Submit {verdict} review to {preview.pr.repo}#{preview.pr.number} at{" "}
                {preview.pr.headSha.slice(0, 8)} with {preview.comments.length} comments and{" "}
                {preview.suggestions.filter((entry) => entry.accepted).length} suggestions?
              </p>
              <p className="whitespace-pre-wrap">{summary}</p>
              <Button
                size="xs"
                disabled={busy || !canSubmit}
                onClick={() =>
                  void run(async () => {
                    if (!destination || !canSubmit) return;
                    const current = await request("pr-review");
                    if (helixPrReviewFingerprint(current) !== helixPrReviewFingerprint(preview)) {
                      setPreview(null);
                      throw new Error("The HX review changed. Check the drafts and preview again.");
                    }
                    if (outcomes.has(key)) return;
                    remember({ status: "submitting", revision: preview.revision, cleaned: false });
                    try {
                      const result = await submit({
                        ...destination,
                        input: {
                          ...destination.input,
                          ...helixPrReviewInput(preview, summary, verdict),
                        },
                      });
                      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                    } catch (cause) {
                      remember({ status: "uncertain", revision: preview.revision, cleaned: false });
                      throw cause;
                    }
                    remember({ status: "submitted", revision: preview.revision, cleaned: false });
                    await cleanup(preview.revision);
                    detail.refresh();
                  })
                }
              >
                Submit review to GitHub
              </Button>
              <Button size="xs" onClick={() => setPreview(null)}>
                Back to drafts
              </Button>
            </div>
          ) : (
            <Button
              size="xs"
              disabled={busy || !canSubmit}
              onClick={() =>
                void run(async () => {
                  const current = await request("pr-review");
                  const input = helixPrReviewInput(current, summary, verdict);
                  if (
                    input.comments.length &&
                    (!detail.data?.capabilities.review.inlineComment ||
                      !detail.data.viewerPermissions.comment)
                  )
                    throw new Error(
                      "This connection cannot submit line comments. Your drafts are kept in Helix.",
                    );
                  if (
                    detail.data &&
                    sourceControlClients.get(detail.data.provider).reviewSummaryRequired(verdict) &&
                    !summary.trim()
                  )
                    throw new Error("Add a summary before requesting changes.");
                  setPreview(current);
                })
              }
            >
              Preview review
            </Button>
          )}
          {detail.data && detail.data.headSha !== review?.pr.headSha ? (
            <p role="alert">The PR head changed. Reopen an updated checkout before submitting.</p>
          ) : null}
          {detail.data && !detail.data.capabilities.review.multilineComment ? (
            <p>Update the T3 server to submit reviews pinned to the PR revision.</p>
          ) : null}
          {error || detail.error || review?.error ? (
            <p role="alert" className="text-destructive">
              {error ?? detail.error ?? review?.error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
