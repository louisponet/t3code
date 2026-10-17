import { useAtomValue } from "@effect/atom-react";
import { useParams } from "@tanstack/react-router";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { useMemo, useState } from "react";
import { type DraftId } from "../composerDraftStore";
import { selectThreadDiffPanelSelection, useDiffPanelStore } from "../diffPanelStore";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { useCheckpointDiff } from "~/lib/checkpointDiffState";
import { useProject, useThreadProjection, useThreadShell } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { reviewEnvironment } from "../state/review";
import { serverEnvironment } from "../state/server";
import { resolveThreadRouteRef } from "../threadRoutes";
import { DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import HelixPanel from "./HelixPanel";
import { Button } from "./ui/button";

export default function DiffPanel({
  mode = "inline",
}: {
  mode?: DiffPanelMode;
  composerDraftTarget: ScopedThreadRef | DraftId;
  workspaceMutationId: string | null;
}) {
  const threadRef = useParams({ strict: false, select: (params) => resolveThreadRouteRef(params) });
  const thread = useThreadShell(threadRef);
  const project = useProject(
    thread ? { environmentId: thread.environmentId, projectId: thread.projectId } : null,
  );
  const projection = useThreadProjection(threadRef)?.projection ?? null;
  const cwd = thread?.worktreePath ?? project?.workspaceRoot;
  const config = useAtomValue(serverEnvironment.configValueAtom(threadRef?.environmentId ?? null));
  const selection = useDiffPanelStore((state) =>
    selectThreadDiffPanelSelection(state.byThreadKey, threadRef),
  );
  const { turnDiffSummaries, inferredCheckpointTurnCountByRunId } =
    useTurnDiffSummaries(projection);
  const turns = useMemo(
    () => [...turnDiffSummaries].sort((a, b) => b.completedAt.localeCompare(a.completedAt)),
    [turnDiffSummaries],
  );
  const selectedTurn =
    selection.kind === "turn" ? turns.find((turn) => turn.runId === selection.turnId) : undefined;
  const turnCount = selectedTurn
    ? (selectedTurn.checkpointTurnCount ?? inferredCheckpointTurnCountByRunId[selectedTurn.runId])
    : undefined;
  const checkpoint = useCheckpointDiff(
    {
      environmentId: threadRef?.environmentId ?? null,
      threadId: threadRef?.threadId ?? null,
      fromTurnCount: turnCount === undefined ? null : Math.max(0, turnCount - 1),
      toTurnCount: turnCount ?? null,
      ignoreWhitespace: false,
      cacheScope: selectedTurn ? `turn:${selectedTurn.runId}` : null,
    },
    { enabled: selection.kind === "turn" && turnCount !== undefined },
  );
  const preview = useEnvironmentQuery(
    thread && cwd && selection.kind !== "turn"
      ? reviewEnvironment.diffPreview({
          environmentId: thread.environmentId,
          input: {
            cwd,
            ...(selection.kind === "branch" && selection.baseRef
              ? { baseRef: selection.baseRef }
              : {}),
          },
        })
      : null,
  );
  const source = preview.data?.sources.find(
    (entry) => entry.kind === (selection.kind === "unstaged" ? "working-tree" : "branch-range"),
  );
  const [baseRef, setBaseRef] = useState("");
  const value = selection.kind === "turn" ? `turn:${selection.turnId}` : selection.kind;
  const header = (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <select
        aria-label="Review scope"
        className="min-w-0 rounded border border-border bg-background px-2 py-1 text-xs"
        value={value}
        onChange={(event) => {
          if (!threadRef) return;
          const value = event.target.value;
          if (value === "branch" || value === "unstaged")
            useDiffPanelStore.getState().selectGitScope(threadRef, value);
          else {
            const turn = turns.find((entry) => `turn:${entry.runId}` === value);
            if (turn) useDiffPanelStore.getState().selectTurn(threadRef, turn.runId);
          }
        }}
      >
        <option value="branch">Changes</option>
        <option value="unstaged">Uncommitted</option>
        {turns.map((turn, index) => (
          <option key={turn.runId} value={`turn:${turn.runId}`}>
            {index === 0
              ? "Latest turn"
              : `Turn ${turn.checkpointTurnCount ?? inferredCheckpointTurnCountByRunId[turn.runId] ?? "?"}`}
          </option>
        ))}
      </select>
      {selection.kind === "branch" ? (
        <form
          className="flex min-w-0 items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (threadRef)
              useDiffPanelStore.getState().selectBranchBaseRef(threadRef, baseRef || null);
          }}
        >
          <input
            aria-label="Comparison base reference"
            className="min-w-0 w-32 bg-transparent text-xs"
            placeholder={source?.baseRef ?? "Automatic base"}
            value={baseRef}
            onChange={(event) => setBaseRef(event.target.value)}
          />
          <Button size="xs" type="submit">
            Compare
          </Button>
        </form>
      ) : null}
      <Button size="xs" variant="ghost" onClick={() => preview.refresh()}>
        Refresh
      </Button>
    </div>
  );
  let body;
  if (!threadRef || !cwd)
    body = <p className="p-4 text-sm text-muted-foreground">Select a thread to review changes.</p>;
  else if (selection.kind === "turn") {
    const comparison = checkpoint.data?.helixComparison;
    if (checkpoint.isPending)
      body = <p className="p-4 text-sm text-muted-foreground">Loading checkpoint comparison…</p>;
    else if (checkpoint.error)
      body = (
        <p role="alert" className="p-4 text-sm text-destructive">
          {checkpoint.error}
        </p>
      );
    else if (comparison)
      body = (
        <HelixPanel
          threadRef={threadRef}
          cwd={comparison.cwd}
          worktreePath={comparison.cwd}
          keybindings={config?.keybindings ?? DEFAULT_RESOLVED_KEYBINDINGS}
          options={{
            baseline: comparison.baseline,
            worktreePath: comparison.cwd,
            ...(selection.filePath
              ? { filePath: selection.filePath }
              : {
                  revision: comparison.revision,
                  ignoreWhitespace: comparison.ignoreWhitespace,
                  ...(comparison.filePaths ? { filePaths: comparison.filePaths } : {}),
                }),
          }}
          requestId={selection.revealRequestId}
        />
      );
    else
      body = (
        <p className="p-4 text-sm text-muted-foreground">
          {checkpoint.data?.diff
            ? "Update this environment’s T3 server to open the exact checkpoint comparison in Helix."
            : "No changes in this turn."}
        </p>
      );
  } else if (preview.error)
    body = (
      <p role="alert" className="p-4 text-sm text-destructive">
        {preview.error}
      </p>
    );
  else if (!source)
    body = (
      <p className="p-4 text-sm text-muted-foreground">
        {preview.isPending ? "Loading comparison…" : "No changes."}
      </p>
    );
  else if (selection.kind === "branch" && !source.helixBaseline)
    body = (
      <p role="alert" className="p-4 text-sm text-muted-foreground">
        Update this environment’s T3 server to open the resolved branch comparison in Helix.
      </p>
    );
  else
    body = (
      <HelixPanel
        threadRef={threadRef}
        cwd={cwd}
        worktreePath={thread?.worktreePath}
        keybindings={config?.keybindings ?? DEFAULT_RESOLVED_KEYBINDINGS}
        options={{
          baseline: selection.kind === "unstaged" ? "HEAD" : source.helixBaseline!,
          worktreePath: cwd,
        }}
      />
    );
  return (
    <DiffPanelShell mode={mode} header={header}>
      {body}
    </DiffPanelShell>
  );
}
