import { useAtomValue } from "@effect/atom-react";
import type {
  HelixPrComment,
  HelixPrReviewSnapshot,
  HelixPrSelection,
  HelixReviewTarget,
} from "@t3tools/client-runtime/helix-review-control";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, type PullRequestReviewVerdict } from "@t3tools/contracts";
import * as Atom from "effect/reactivity/Atom";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { nativePullRequestDestination } from "../../lib/pullRequestNavigation";
import { appAtomRegistry } from "../../state/atom-registry";
import { composerPullRequests } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { pullRequestTarget } from "../pull-requests/usePullRequestDiff";
import { helixPrActionText, helixPrReviewFingerprint, helixPrReviewInput } from "./helixPrReview";
import type { useHelixReviewControls } from "./useHelixReviewControls";

type Session = {
  target: HelixReviewTarget;
  projectId: string;
  review: HelixPrReviewSnapshot | null;
};
export type HelixPrCommentEditor = {
  revision: string;
  anchor: HelixPrSelection | HelixPrComment;
  draftId?: string;
  selectionId?: string;
  body: string;
};
export type HelixPrReviewPreview = {
  review: HelixPrReviewSnapshot;
  input: ReturnType<typeof helixPrReviewInput>;
};
type Submission = {
  status: "submitting" | "submitted" | "uncertain";
  preview: HelixPrReviewPreview;
  cleaned: boolean;
};
// Keep the provider outcome when a sheet or terminal route is reopened. HX
// cleanup is a separate operation and must never cause another provider write.
const submissionsAtom = Atom.make<ReadonlyMap<string, Submission>>(new Map()).pipe(Atom.keepAlive);
const noPermission = Atom.make(false);
function submissionKey(target: HelixReviewTarget) {
  return JSON.stringify([target.environmentId, target.threadId, target.terminalId, target.nonce]);
}
function setSubmission(key: string, submission: Submission | null) {
  const next = new Map(appAtomRegistry.get(submissionsAtom));
  if (submission) next.set(key, submission);
  else next.delete(key);
  appAtomRegistry.set(submissionsAtom, next);
}
function sameEditor(left: HelixReviewTarget, right: HelixReviewTarget | null) {
  return right !== null && submissionKey(left) === submissionKey(right);
}

export function useHelixPrReview(input: {
  controls: ReturnType<typeof useHelixReviewControls>;
  projectId: string | null;
}) {
  const latest = useRef(input);
  useLayoutEffect(() => {
    latest.current = input;
  }, [input]);
  const [session, setSession] = useState<Session | null>(null);
  const [mode, setMode] = useState<"comment" | "review" | null>(null);
  const [editor, setEditor] = useState<HelixPrCommentEditor | null>(null);
  const [summary, setSummary] = useState("");
  const [verdict, setVerdict] = useState<PullRequestReviewVerdict>("comment");
  const [preview, setPreview] = useState<HelixPrReviewPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const submissions = useAtomValue(submissionsAtom);
  const key = session ? submissionKey(session.target) : null;
  const submission = key ? (submissions.get(key) ?? null) : null;
  const review = session?.review ?? null;
  const current = session !== null && sameEditor(session.target, input.controls.target);
  const destination =
    session && review
      ? nativePullRequestDestination(review.pr.url, {
          environmentId: session.target.environmentId,
          projectId: session.projectId,
        })
      : null;
  const target = destination ? pullRequestTarget(destination) : null;
  const detail = useEnvironmentQuery(mode && target ? composerPullRequests.detail(target) : null);
  const detailKey = target ? JSON.stringify(target) : null;
  const refreshDetail = detail.refresh;
  useEffect(() => {
    if (mode && detailKey) refreshDetail();
  }, [mode, detailKey, refreshDetail]);
  const permitted = useAtomValue(
    session
      ? composerPullRequests.submitReview.permissionAtom(
          EnvironmentId.make(session.target.environmentId),
        )
      : noPermission,
  );
  const submitReview = useAtomCommand(composerPullRequests.submitReview, { reportFailure: false });
  const verdicts =
    permitted && detail.data?.state === "open"
      ? detail.data.capabilities.review.verdicts.filter((value) =>
          detail.data?.viewerPermissions.verdicts.includes(value),
        )
      : [];
  const staleHead =
    review !== null && detail.data !== null && detail.data.headSha !== review.pr.headSha;
  const canInline =
    detail.data?.capabilities.review.inlineComment && detail.data.viewerPermissions.comment;
  // This capability arrived with head-pinned review writes. Older servers strip
  // both unknown range fields and expectedHeadSha, so they cannot safely submit.
  const submissionSupported = detail.data?.capabilities.review.multilineComment === true;
  const working = busy || input.controls.busy || submission?.status === "submitting";
  const editable = current && !working && !input.controls.canRetry && submission === null;

  const currentTarget = (captured: Session) => {
    const next = latest.current.controls.target;
    if (!sameEditor(captured.target, next) || !next)
      throw new Error(
        "This HX session changed or disconnected. Your text is kept; reconnect to the same editor.",
      );
    return next;
  };
  const run = async <A>(operation: () => Promise<A>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      return await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update the HX review.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const request = async (
    captured: Session,
    action: "pr-review" | "pr-comment" | "pr-suggestion" | "pr-complete",
    value?: unknown,
  ) => {
    const bound = currentTarget(captured);
    const payload = await latest.current.controls.runPrAction(
      bound,
      action,
      value === undefined ? undefined : helixPrActionText(value),
    );
    if (!payload)
      throw new Error(
        "HX did not confirm the review update. Retry the previous action if offered, then refresh.",
      );
    if (payload.error) throw new Error(payload.error);
    return payload;
  };
  const refresh = async (captured = session) => {
    if (!captured) return null;
    const payload = await request(captured, "pr-review");
    if (!payload.review) throw new Error("This HX editor is not reviewing a pull request.");
    const updated = { ...captured, target: currentTarget(captured), review: payload.review };
    setSession(updated);
    return updated;
  };
  const open = (nextMode: "comment" | "review") =>
    void run(async () => {
      const controls = latest.current.controls;
      if (!controls.target || !latest.current.projectId || controls.canRetry) return;
      const previous = session && sameEditor(session.target, controls.target);
      const captured: Session = {
        target: controls.target,
        projectId: latest.current.projectId,
        review: controls.prReview,
      };
      const priorSubmission = appAtomRegistry
        .get(submissionsAtom)
        .get(submissionKey(captured.target));
      setSession(captured);
      setMode(priorSubmission ? "review" : nextMode);
      setPreview(priorSubmission?.preview ?? null);
      if (!previous) {
        setSummary("");
        setVerdict("comment");
        setEditor(null);
      }
      if (priorSubmission) return;
      const updated = await refresh(captured);
      if (nextMode === "comment" && updated?.review) {
        const selection = updated.review.selection;
        if (!selection) {
          setEditor(null);
          throw new Error("Select code in HX, then refresh the selection to draft a line comment.");
        }
        setEditor((old) => ({
          revision: updated.review!.revision,
          anchor: selection,
          selectionId: selection.id,
          body: previous && old?.selectionId === selection.id ? old.body : "",
        }));
      } else setEditor(null);
    });
  const refreshSheet = () =>
    void run(async () => {
      if (latest.current.controls.canRetry)
        throw new Error("Retry the previous HX action before refreshing.");
      const updated = await refresh();
      if (!updated?.review) return;
      const fresh = updated.review;
      if (mode === "comment" || editor) {
        const anchor = editor?.draftId
          ? fresh.comments.find((comment) => comment.id === editor.draftId)
          : fresh.selection;
        if (!anchor) throw new Error("Select code in HX, then refresh the selection.");
        // Refresh selection is an explicit user action; keep the typed body while
        // showing the new anchor before Save draft can be pressed.
        setEditor({
          revision: fresh.revision,
          anchor,
          body: editor?.body ?? "",
          ...(editor?.draftId ? { draftId: editor.draftId } : { selectionId: anchor.id }),
        });
      }
      detail.refresh();
      setPreview(null);
    });
  const mutate = (action: "pr-comment" | "pr-suggestion", value: unknown, closeEditor = false) =>
    void run(async () => {
      if (!session || !editable) return;
      const payload = await request(session, action, value);
      if (!payload.review)
        throw new Error("HX returned no review. Your text is kept; refresh before continuing.");
      setSession({ ...session, target: currentTarget(session), review: payload.review });
      setPreview(null);
      if (closeEditor) {
        setEditor(null);
        if (mode === "comment") setMode(null);
      }
    });
  const preparePreview = () =>
    void run(async () => {
      if (!session || !editable || !verdicts.includes(verdict) || staleHead || !submissionSupported)
        return;
      const updated = await refresh(session);
      if (!updated?.review) return;
      const frozen = {
        review: updated.review,
        input: helixPrReviewInput(updated.review, summary, verdict),
      };
      if (frozen.input.comments.length && !canInline)
        throw new Error(
          "You cannot submit line comments on this pull request. Your drafts are kept in HX.",
        );
      if (
        detail.data &&
        sourceControlClients.get(detail.data.provider).reviewSummaryRequired(verdict) &&
        !summary.trim()
      )
        throw new Error("Add a summary before requesting changes.");
      setPreview(frozen);
    });
  const cleanup = async (captured: Session, outcome: Submission) => {
    const scope = submissionKey(captured.target);
    try {
      currentTarget(captured);
      if (latest.current.controls.canRetry) {
        if (
          latest.current.controls.retryAction !== "pr-complete" ||
          !(await latest.current.controls.retry())
        )
          throw new Error("Retry the previous HX action before syncing submitted drafts.");
      } else await request(captured, "pr-complete", { revision: outcome.preview.review.revision });
      setSubmission(scope, { ...outcome, cleaned: true });
    } catch (cause) {
      throw new Error(
        `Review submitted. HX drafts were kept because cleanup was not confirmed. ${cause instanceof Error ? cause.message : "Try syncing the drafts again."}`,
        { cause },
      );
    }
  };
  const performSubmit = () =>
    void run(async () => {
      if (
        !session ||
        !preview ||
        !target ||
        !editable ||
        !permitted ||
        !submissionSupported ||
        !verdicts.includes(preview.input.verdict)
      )
        return;
      const scope = submissionKey(session.target);
      if (appAtomRegistry.get(submissionsAtom).has(scope)) return;
      const updated = await refresh(session);
      if (
        !updated?.review ||
        helixPrReviewFingerprint(updated.review) !== helixPrReviewFingerprint(preview.review)
      ) {
        setPreview(null);
        throw new Error(
          "The HX review changed. Check the updated comments and suggestions, then preview again.",
        );
      }
      const initial: Submission = { status: "submitting", preview, cleaned: false };
      if (appAtomRegistry.get(submissionsAtom).has(scope)) return;
      setSubmission(scope, initial);
      try {
        const response = await submitReview({
          ...target,
          input: { ...target.input, ...preview.input },
        });
        if (response._tag === "Failure") throw squashAtomCommandFailure(response);
      } catch (cause) {
        setSubmission(scope, { ...initial, status: "uncertain" });
        throw new Error(
          `Could not confirm review submission. Check the pull request before posting again. ${cause instanceof Error ? cause.message : "Your HX drafts are kept."}`,
          { cause },
        );
      }
      const accepted: Submission = { ...initial, status: "submitted" };
      setSubmission(scope, accepted);
      await cleanup(session, accepted);
      detail.refresh();
    });

  return {
    mode,
    review,
    editor,
    summary,
    verdict,
    verdicts,
    preview: submission?.preview ?? preview,
    submission,
    busy: working,
    editable,
    current,
    staleHead,
    submissionSupported: detail.data === null ? null : submissionSupported,
    canPreview:
      editable &&
      permitted &&
      submissionSupported &&
      verdicts.includes(verdict) &&
      !staleHead &&
      !detail.isPending &&
      !detail.error &&
      !review?.error &&
      !review?.comments.some((comment) => comment.replyTo !== undefined),
    error: error ?? input.controls.error ?? review?.error ?? detail.error,
    canRetry: input.controls.canRetry,
    open,
    close: () => setMode(null),
    setSummary: (text: string) => {
      setSummary(text);
      setPreview(null);
    },
    setVerdict: (value: PullRequestReviewVerdict) => {
      setVerdict(value);
      setPreview(null);
    },
    edit: (comment: HelixPrComment) => {
      if (review && editable) {
        setEditor({
          revision: review.revision,
          anchor: comment,
          draftId: comment.id,
          body: comment.body,
        });
        setPreview(null);
      }
    },
    cancelEditor: () => {
      setEditor(null);
      if (mode === "comment") setMode(null);
    },
    setBody: (body: string) => setEditor((old) => (old ? { ...old, body } : null)),
    save: () => {
      if (!editor || !editor.body.trim()) return;
      mutate(
        "pr-comment",
        {
          revision: editor.revision,
          ...(editor.draftId ? { id: editor.draftId } : { selectionId: editor.selectionId }),
          body: editor.body,
        },
        true,
      );
    },
    remove: (id: string) => {
      if (review) mutate("pr-comment", { revision: review.revision, id, body: null });
    },
    toggleSuggestion: (id: string, accepted: boolean) => {
      if (review) mutate("pr-suggestion", { revision: review.revision, id, accepted });
    },
    refresh: refreshSheet,
    retry: () =>
      void run(async () => {
        const controls = latest.current.controls;
        const action = controls.retryAction;
        const bound = controls.target;
        const captured =
          session && sameEditor(session.target, bound)
            ? session
            : bound && latest.current.projectId
              ? { target: bound, projectId: latest.current.projectId, review: controls.prReview }
              : null;
        const outcome = bound
          ? appAtomRegistry.get(submissionsAtom).get(submissionKey(bound))
          : null;
        if (action === "pr-complete" && captured && outcome?.status === "submitted") {
          await cleanup(captured, outcome);
          return;
        }
        if (await controls.retry()) {
          if (action === "pr-comment") {
            setEditor(null);
            if (mode === "comment") setMode(null);
          }
          await refresh(captured);
        }
      }),
    preparePreview,
    backToDrafts: () => setPreview(null),
    submit: performSubmit,
    syncSubmitted: () =>
      void run(async () => {
        if (session && submission?.status === "submitted") await cleanup(session, submission);
      }),
    startNew: () =>
      void run(async () => {
        if (
          !session ||
          !key ||
          !submission ||
          submission.status === "submitting" ||
          (submission.status === "submitted" && !submission.cleaned)
        )
          return;
        setSubmission(key, null);
        setPreview(null);
        setSummary("");
        setEditor(null);
        await refresh(session);
      }),
  };
}
