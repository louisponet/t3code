import { useAtomValue } from "@effect/atom-react";
import {
  AuthSettingsWriteScope,
  DEFAULT_ENVIRONMENT_TOOL_PROBE_INTERVAL_SECONDS,
  DEFAULT_ENVIRONMENT_TOOL_PROBE_TIMEOUT_SECONDS,
  type EnvironmentId,
  type EnvironmentToolId,
  type EnvironmentToolKind,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { decodeEnvironmentTools, slugEnvironmentToolId } from "@t3tools/shared/environmentTools";
import { ChevronRightIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { cn } from "../../lib/utils";
import {
  environmentToolRowsAtom,
  useEnvironmentToolsEnvironmentIds,
} from "../../state/environmentTools";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

/** Asks first, then removes the entry; the server closes the tool's sessions. */
export function useRemoveEnvironmentTool() {
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, "tool removal");
  return async (environmentId: EnvironmentId, key: string, name: string): Promise<boolean> => {
    if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope)) return false;
    const confirmed = await requestConfirmDialog(`Remove ${name}?`, { variant: "destructive" });
    if (confirmed !== true) return false;
    const result = await updateSettings({
      environmentId,
      input: { patch: { tools: { [key]: null } } },
    });
    return result._tag === "Success";
  };
}

/** Creates a tool when `toolId` is undefined, otherwise edits that tool in place. */
export function ToolEditorDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId?: EnvironmentId | undefined;
  toolId?: EnvironmentToolId | undefined;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      {/* The popup mounts the form per opening, so each opening starts from the saved tool. */}
      <DialogPopup className="max-w-lg">
        <ToolEditorForm
          environmentId={props.environmentId}
          toolId={props.toolId}
          onClose={() => props.onOpenChange(false)}
        />
      </DialogPopup>
    </Dialog>
  );
}

function ToolEditorForm(props: {
  environmentId: EnvironmentId | undefined;
  toolId: EnvironmentToolId | undefined;
  onClose: () => void;
}) {
  const formId = useId();
  const capableIds = useEnvironmentToolsEnvironmentIds();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [environmentId, setEnvironmentId] = useState<EnvironmentId | null>(() => {
    if (props.environmentId !== undefined) return props.environmentId;
    const writable = capableIds.filter((id) => readEnvironmentScope(id, AuthSettingsWriteScope));
    const pool = writable.length > 0 ? writable : capableIds;
    return pool.find((id) => id === primaryEnvironmentId) ?? pool[0] ?? null;
  });
  const { environments } = useEnvironments();
  const capableEnvironments = environments.filter((environment) =>
    capableIds.includes(environment.environmentId),
  );
  const environment =
    environments.find((candidate) => candidate.environmentId === environmentId) ?? null;
  const environmentLabel = environment?.label ?? "this environment";
  const existing =
    useAtomValue(environmentToolRowsAtom).rows.find(
      (row) => row.environmentId === environmentId && row.toolId === props.toolId && !row.offline,
    )?.definition ?? null;
  const editing = props.toolId !== undefined;
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const removeTool = useRemoveEnvironmentTool();

  const [name, setName] = useState(existing?.name ?? "");
  const [kind, setKind] = useState<EnvironmentToolKind>(existing?.kind ?? "terminal");
  const [command, setCommand] = useState(existing?.kind === "terminal" ? existing.command : "");
  const [cwd, setCwd] = useState(existing?.kind === "terminal" ? (existing.cwd ?? "") : "");
  const target = existing?.kind === "browser" || existing?.kind === "web" ? existing.target : null;
  const webAppsCapable =
    environment?.serverConfig?.environment.capabilities.environmentToolWebApps === true;
  const [targetKind, setTargetKind] = useState(target?.kind ?? "url");
  const [url, setUrl] = useState(target?.kind === "url" ? target.url : "");
  const [port, setPort] = useState(target?.kind === "environment-port" ? String(target.port) : "");
  const [path, setPath] = useState(target?.kind === "environment-port" ? (target.path ?? "") : "");
  const [https, setHttps] = useState(
    target?.kind === "environment-port" && target.protocol === "https",
  );
  const [statusOpen, setStatusOpen] = useState(existing?.status !== undefined);
  const [probeCommand, setProbeCommand] = useState(existing?.status?.command ?? "");
  const [probeInterval, setProbeInterval] = useState(
    existing?.status?.intervalSeconds?.toString() ?? "",
  );
  const [probeTimeout, setProbeTimeout] = useState(
    existing?.status?.timeoutSeconds?.toString() ?? "",
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const takenIds = new Set(Object.keys(environment?.serverConfig?.settings.tools ?? {}));
  const toolId = props.toolId ?? slugEnvironmentToolId(name, takenIds);
  const missing = editing && existing === null;
  const disabled = saving || !canWrite || environmentId === null || missing;
  const unsupportedWebApp = kind === "web" && !webAppsCapable;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (disabled || unsupportedWebApp || environmentId === null) return;
    if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope)) {
      setError("This connection cannot change tools.");
      return;
    }
    const cwdValue = cwd.trim();
    const probe = probeCommand.trim();
    const decoded = decodeEnvironmentTools({
      [toolId]: {
        kind,
        name: name.trim(),
        ...(existing?.description === undefined ? {} : { description: existing.description }),
        ...(probe === ""
          ? {}
          : {
              status: {
                command: probe,
                ...(probeInterval.trim() === "" ? {} : { intervalSeconds: Number(probeInterval) }),
                ...(probeTimeout.trim() === "" ? {} : { timeoutSeconds: Number(probeTimeout) }),
              },
            }),
        ...(kind === "terminal"
          ? {
              command: command.trim(),
              ...(cwdValue === "" || cwdValue === "~" ? {} : { cwd: cwdValue }),
            }
          : {
              target:
                targetKind === "url"
                  ? { kind: "url", url: url.trim() }
                  : {
                      kind: "environment-port",
                      port: Number(port),
                      ...(https ? { protocol: "https" } : {}),
                      ...(path.trim() === "" ? {} : { path: path.trim() }),
                    },
            }),
      },
    });
    const definition = decoded.tools[0]?.definition;
    if (definition === undefined) {
      setError(decoded.issues[0]?.message ?? "This tool is not valid.");
      return;
    }
    setError(null);
    setSaving(true);
    const result = await updateSettings({
      environmentId,
      input: { patch: { tools: { [toolId]: definition } } },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "The tool was not saved.");
      }
      return;
    }
    props.onClose();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{editing ? `Edit ${existing?.name ?? props.toolId}` : "Add tool"}</DialogTitle>
        <DialogDescription>
          {kind === "web"
            ? `Web apps open on this device. Ports connect to ${environmentLabel}.`
            : `Tools run on ${environmentLabel} and open as a page from the sidebar.`}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <form id={formId} className="grid gap-4" onSubmit={submit}>
          {/* Outside the fieldset so a read-only environment cannot lock the way back out. */}
          {!editing && capableEnvironments.length > 1 ? (
            <Field label="Runs on" htmlFor="tool-environment">
              <Select
                value={environmentId}
                disabled={saving}
                onValueChange={(id) => {
                  const next = capableIds.find((candidate) => candidate === id);
                  if (next) setEnvironmentId(next);
                }}
              >
                <SelectTrigger id="tool-environment" size="sm">
                  <SelectValue>
                    <span className="flex items-center gap-2">
                      <EnvironmentMachineIcon
                        kind={resolveEnvironmentMachineKind(environment?.serverConfig ?? null)}
                        className="size-4"
                      />
                      {environmentLabel}
                    </span>
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {capableEnvironments.map((entry) => (
                    <SelectItem
                      key={entry.environmentId}
                      value={entry.environmentId}
                      label={entry.label}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <EnvironmentMachineIcon
                          kind={resolveEnvironmentMachineKind(entry.serverConfig)}
                          className="size-4"
                        />
                        <span className="truncate">{entry.label}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
          ) : null}
          <fieldset className="grid gap-4" disabled={disabled}>
            {missing ? (
              <p className="text-sm text-destructive-foreground" role="status">
                This tool was removed, or {environmentLabel} is offline.
              </p>
            ) : environmentId === null ? (
              <p className="text-sm text-destructive-foreground" role="status">
                No connected environment supports tools.
              </p>
            ) : !canWrite ? (
              <p className="text-sm text-destructive-foreground" role="status">
                This connection cannot change tools on {environmentLabel}.
              </p>
            ) : null}
            <Field
              label="Name"
              htmlFor="tool-name"
              hint={name.trim() === "" ? undefined : `tool.${toolId}.open`}
            >
              <Input
                id="tool-name"
                autoFocus
                placeholder="lazygit"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <ToggleGroup
              aria-label="Tool kind"
              value={[kind]}
              onValueChange={(values) => {
                const next = values[0];
                if (next === "terminal" || next === "browser" || next === "web") setKind(next);
              }}
            >
              <Toggle value="terminal">Terminal</Toggle>
              <Toggle value="browser">Browser</Toggle>
              {webAppsCapable || kind === "web" ? <Toggle value="web">Web app</Toggle> : null}
            </ToggleGroup>
            {unsupportedWebApp ? (
              <p className="text-sm text-destructive-foreground" role="status">
                {environmentLabel} needs a newer T3 Code to run web apps.
              </p>
            ) : null}
            {kind === "terminal" ? (
              <>
                <Field label="Command" htmlFor="tool-command">
                  <Input
                    id="tool-command"
                    placeholder="lazygit"
                    value={command}
                    onChange={(event) => setCommand(event.target.value)}
                  />
                </Field>
                <Field label="Working directory" htmlFor="tool-cwd" hint={`on ${environmentLabel}`}>
                  <Input
                    id="tool-cwd"
                    placeholder="~"
                    value={cwd}
                    onChange={(event) => setCwd(event.target.value)}
                  />
                </Field>
              </>
            ) : (
              <>
                <ToggleGroup
                  aria-label={kind === "web" ? "Web app target" : "Browser target"}
                  value={[targetKind]}
                  onValueChange={(values) => {
                    const next = values[0];
                    if (next === "url" || next === "environment-port") setTargetKind(next);
                  }}
                >
                  <Toggle value="url">URL</Toggle>
                  <Toggle value="environment-port">Port on {environmentLabel}</Toggle>
                </ToggleGroup>
                {targetKind === "url" ? (
                  <Field label="URL" htmlFor="tool-url">
                    <Input
                      id="tool-url"
                      placeholder="https://grafana.example.com"
                      value={url}
                      onChange={(event) => setUrl(event.target.value)}
                    />
                  </Field>
                ) : (
                  <>
                    <div className="grid grid-cols-[6rem_1fr] gap-3">
                      <Field label="Port" htmlFor="tool-port">
                        <Input
                          id="tool-port"
                          inputMode="numeric"
                          placeholder="3000"
                          value={port}
                          onChange={(event) => setPort(event.target.value)}
                        />
                      </Field>
                      <Field label="Path" htmlFor="tool-path" hint="optional">
                        <Input
                          id="tool-path"
                          placeholder="/dashboard"
                          value={path}
                          onChange={(event) => setPath(event.target.value)}
                        />
                      </Field>
                    </div>
                    <Label className="flex items-center justify-between">
                      <span>Use HTTPS</span>
                      <Switch checked={https} onCheckedChange={(checked) => setHttps(checked)} />
                    </Label>
                  </>
                )}
              </>
            )}
            <Collapsible open={statusOpen} onOpenChange={setStatusOpen}>
              <CollapsibleTrigger className="flex items-center gap-1.5 rounded-md text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                <ChevronRightIcon
                  aria-hidden
                  className={cn(
                    "size-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
                    statusOpen && "rotate-90",
                  )}
                />
                Status badge
              </CollapsibleTrigger>
              <CollapsiblePanel>
                <div className="grid gap-4 pt-3">
                  <Field label="Probe command" htmlFor="tool-probe" hint="prints badge JSON">
                    <Input
                      id="tool-probe"
                      placeholder="gtc prs --badge"
                      value={probeCommand}
                      onChange={(event) => setProbeCommand(event.target.value)}
                    />
                  </Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Every" htmlFor="tool-probe-interval" hint="seconds">
                      <Input
                        id="tool-probe-interval"
                        inputMode="numeric"
                        placeholder={String(DEFAULT_ENVIRONMENT_TOOL_PROBE_INTERVAL_SECONDS)}
                        value={probeInterval}
                        onChange={(event) => setProbeInterval(event.target.value)}
                      />
                    </Field>
                    <Field label="Timeout" htmlFor="tool-probe-timeout" hint="seconds">
                      <Input
                        id="tool-probe-timeout"
                        inputMode="numeric"
                        placeholder={String(DEFAULT_ENVIRONMENT_TOOL_PROBE_TIMEOUT_SECONDS)}
                        value={probeTimeout}
                        onChange={(event) => setProbeTimeout(event.target.value)}
                      />
                    </Field>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Runs on {environmentLabel} while someone is watching. Leave it empty for no
                    badge.
                  </p>
                </div>
              </CollapsiblePanel>
            </Collapsible>
            {error ? (
              <p className="text-sm text-destructive-foreground" role="alert">
                {error}
              </p>
            ) : null}
          </fieldset>
        </form>
      </DialogPanel>
      <DialogFooter variant="bare">
        {editing && existing !== null && environmentId !== null ? (
          <Button
            type="button"
            variant="destructive-outline"
            className="sm:mr-auto"
            disabled={disabled}
            onClick={async () => {
              if (await removeTool(environmentId, toolId, existing.name)) props.onClose();
            }}
          >
            Remove
          </Button>
        ) : null}
        <Button type="button" variant="outline" onClick={props.onClose}>
          Cancel
        </Button>
        <Button form={formId} type="submit" disabled={disabled || unsupportedWebApp}>
          {saving ? "Saving…" : editing ? "Save changes" : "Add tool"}
        </Button>
      </DialogFooter>
    </>
  );
}

function Field(props: {
  label: string;
  hint?: string | undefined;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label className="flex items-baseline justify-between" htmlFor={props.htmlFor}>
        <span>{props.label}</span>
        {props.hint ? (
          <span className="font-normal text-2xs text-muted-foreground/80">{props.hint}</span>
        ) : null}
      </Label>
      {props.children}
    </div>
  );
}
