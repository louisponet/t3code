export const PULL_REQUEST_REVIEW_BRIEF_URL_PLACEHOLDER = "{url}";

export function renderPullRequestReviewBrief(brief: string, url: string): string {
  return brief.replaceAll(PULL_REQUEST_REVIEW_BRIEF_URL_PLACEHOLDER, url);
}

export const DEFAULT_PULL_REQUEST_REVIEW_BRIEF = `Review {url} in this thread. The worktree is checked out at the PR's head. You are the lead reviewer. You run two independent reviewers as delegated tasks of this thread, make them rebut each other, then decide what stands. Do not review the PR only by yourself.

Reviewers (both xhigh):
- Opus: delegate_task target {"providerInstanceId":"claudeAgent","model":"claude-opus-5-5","options":[{"id":"effort","value":"xhigh"}]}
- Sol: delegate_task target {"providerInstanceId":"codex","model":"gpt-6.1-sol","options":[{"id":"reasoningEffort","value":"xhigh"}]}
Use role "review", isolation "shared", mode "async", and a distinct clientRequestId per task. If a target is rejected, read orchestrator_capabilities for the right providerInstanceId and options.

Round 1, independent review. Start both tasks in parallel. Each prompt: review {url} (read the diff with \`gh pr diff {url}\`; the worktree is the PR head) for correctness bugs, concurrency and memory-ordering issues, performance regressions on hot paths, and missing tests; the Opus reviewer also runs the code-review skill at xhigh effort without --comment or --fix. Report findings most severe first, each with an id (A1, A2, ... for Opus; B1, B2, ... for Sol), file:line and a concrete failure scenario, then a one-line verdict. Include these restrictions in every prompt: read-only (no edits, commits, pushes or GitHub posts); do not build or run cargo or tests, since several review threads run at once and builds would compete for the CPU; do only this task, no further delegation, survey fan-out or cross-review. Wait for both to finish (task_status; their completion also wakes this thread), then read each result.

Round 2, rebuttal. Start two new tasks, one per reviewer, with the same targets. Give each the original brief, its own round-1 findings and the other reviewer's round-1 findings in full. Each must try to refute every finding of the other reviewer by reading the code and its callers and looking for the invariant, guard, ordering or type that makes the failure impossible, and answer each id with confirmed (cannot refute; state the concrete failure), refuted (say why it cannot happen) or uncertain (say what is missing). It must also say whether it withdraws any of its own findings after reading the other review. Same restrictions as round 1. Wait for both.

Adjudication, by you. For each finding, weigh the two rebuttals, then check the disputed ones yourself in the code. A finding stands only if you can state its concrete failure; do not keep one because both reviewers agree, and do not drop one because only one of them found it. Classify each as confirmed, refuted or uncertain.

Output: call report_review_findings once with the confirmed and uncertain findings, most severe first, each with path, line, severity and a body that gives the failure scenario and the fix (mark uncertain ones in the title); skip the call when none remain. Then reply with the refuted findings, one line of reasoning each, and end with a one-line verdict: approve, approve with nits, or request changes. If a reviewer task fails or times out, say so and adjudicate with what you have.

Stay read-only yourself: no edits, commits, pushes or GitHub posts, and no cargo builds or tests.`;
