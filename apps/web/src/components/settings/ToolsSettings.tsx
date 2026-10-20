import { useAtomValue } from "@effect/atom-react";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type EnvironmentToolId,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import { browserNavigationTargetUrl } from "@t3tools/shared/browserNavigationTarget";
import { AppWindowIcon, GlobeIcon, PlusIcon, SquareTerminalIcon } from "lucide-react";
import { useState } from "react";

import {
  environmentToolRowsAtom,
  type EnvironmentToolRow,
  useEnvironmentToolsEnvironmentIds,
} from "../../state/environmentTools";
import type { EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ToolEditorDialog, useRemoveEnvironmentTool } from "../tools/ToolEditorDialog";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

type EditorTarget = {
  readonly open: boolean;
  readonly environmentId?: EnvironmentId;
  readonly toolId?: EnvironmentToolId;
};

export function ToolsSettings() {
  const { scope, environments } = useSettingsScope();
  const capableIds = useEnvironmentToolsEnvironmentIds();
  const [editor, setEditor] = useState<EditorTarget>({ open: false });
  const writableIds = useEnvironmentsWithScope(environments, AuthSettingsWriteScope);
  const defaultEnvironmentId =
    environments.find(
      (environment) =>
        capableIds.includes(environment.environmentId) &&
        writableIds.has(environment.environmentId),
    )?.environmentId ?? null;
  return (
    <SettingsPageContainer>
      <SettingsSection
        id="tools"
        title="Tools"
        variant="plain"
        headerAction={
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={defaultEnvironmentId === null}
            onClick={() =>
              defaultEnvironmentId && setEditor({ open: true, environmentId: defaultEnvironmentId })
            }
          >
            <PlusIcon className="size-3" />
            Add tool
          </Button>
        }
      >
        {scope.kind === "unavailable" ? (
          <SettingsRow title={scope.message} />
        ) : environments.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SquareTerminalIcon />
              </EmptyMedia>
              <EmptyTitle>No environments available</EmptyTitle>
              <EmptyDescription>Connect an environment to manage its tools.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="space-y-8">
            {environments.map((environment) => (
              <ToolsEnvironmentSection
                key={environment.environmentId}
                environment={environment}
                showHeading={environments.length > 1}
                onEdit={(toolId) =>
                  setEditor({ open: true, environmentId: environment.environmentId, toolId })
                }
                onAdd={() => setEditor({ open: true, environmentId: environment.environmentId })}
              />
            ))}
          </div>
        )}
      </SettingsSection>
      <ToolEditorDialog
        open={editor.open}
        onOpenChange={(open) => setEditor((current) => ({ ...current, open }))}
        environmentId={editor.environmentId}
        toolId={editor.toolId}
      />
    </SettingsPageContainer>
  );
}

function ToolsEnvironmentSection(props: {
  readonly environment: EnvironmentPresentation;
  readonly showHeading: boolean;
  readonly onEdit: (toolId: EnvironmentToolId) => void;
  readonly onAdd: () => void;
}) {
  const { environment } = props;
  const { rows, issues } = useAtomValue(environmentToolRowsAtom);
  const canWrite = useEnvironmentScope(environment.environmentId, AuthSettingsWriteScope);
  const removeTool = useRemoveEnvironmentTool();
  const connected =
    environment.connection.phase === "connected" && environment.serverConfig !== null;
  const capable = environment.serverConfig?.environment.capabilities.environmentTools === true;
  const tools = rows.filter((row) => row.environmentId === environment.environmentId);
  const environmentIssues = issues.get(environment.environmentId) ?? [];
  return (
    <SettingsSection
      title={environment.label}
      hideTitle={!props.showHeading}
      icon={
        <EnvironmentMachineIcon
          kind={resolveEnvironmentMachineKind(environment.serverConfig)}
          className="size-3.5"
        />
      }
    >
      {!connected ? (
        <SettingsRow
          title="Environment disconnected"
          description={`Reconnect ${environment.label} to manage its tools.`}
        />
      ) : !capable ? (
        <SettingsRow
          title="Tools are not available"
          description={`Update T3 Code on ${environment.label} to add tools there.`}
        />
      ) : (
        <>
          {tools.map((row) => (
            <ToolSettingsRow
              key={row.toolId}
              row={row}
              disabled={!canWrite}
              onEdit={() => props.onEdit(row.toolId)}
            />
          ))}
          {environmentIssues.map((issue) => (
            <SettingsRow
              key={issue.key}
              title={issue.key}
              description={<span className="text-destructive-foreground">{issue.message}</span>}
              control={
                <Button
                  size="xs"
                  variant="destructive-outline"
                  disabled={!canWrite}
                  onClick={() => void removeTool(environment.environmentId, issue.key, issue.key)}
                >
                  Remove
                </Button>
              }
            />
          ))}
          {tools.length === 0 && environmentIssues.length === 0 ? (
            <SettingsRow
              title="No tools"
              description={`Open a terminal app or a web page that runs on ${environment.label} from the sidebar.`}
              control={
                <Button size="xs" variant="outline" disabled={!canWrite} onClick={props.onAdd}>
                  Add tool
                </Button>
              }
            />
          ) : null}
        </>
      )}
    </SettingsSection>
  );
}

function ToolSettingsRow(props: {
  readonly row: EnvironmentToolRow;
  readonly disabled: boolean;
  readonly onEdit: () => void;
}) {
  const { definition } = props.row;
  const Icon =
    definition.kind === "terminal"
      ? SquareTerminalIcon
      : definition.kind === "web"
        ? AppWindowIcon
        : GlobeIcon;
  return (
    <SettingsRow
      title={
        <span className="flex min-w-0 items-center gap-2">
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{definition.name}</span>
        </span>
      }
      description={
        <span className="block truncate font-mono text-xs">
          {definition.kind === "terminal"
            ? `${definition.cwd ?? "~"} $ ${definition.command}`
            : browserNavigationTargetUrl(definition.target)}
        </span>
      }
      control={
        <Button size="xs" variant="outline" disabled={props.disabled} onClick={props.onEdit}>
          Edit
        </Button>
      }
    />
  );
}
