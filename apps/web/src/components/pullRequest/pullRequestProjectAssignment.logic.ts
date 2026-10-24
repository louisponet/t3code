import type { EnvironmentId, EnvironmentMachineKind, ProjectId } from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { workspaceRelativeFilePath } from "@t3tools/shared/path";
import { repositoryPathScope } from "@t3tools/shared/sourceControl";

export interface AssignableProject {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot?: string;
  readonly repositoryIdentity?:
    | {
        readonly canonicalKey?: string | undefined;
        readonly provider?: string | undefined;
        readonly rootPath?: string | undefined;
      }
    | null
    | undefined;
}

/**
 * The directory a project lists on a host that lists a directory's own pull requests; null for
 * a repository's root, or a host that lists the whole repository for every project. A project
 * that cannot be placed inside its repository (one opened through a symlink, which the server
 * resolves and the client cannot) is taken as its own directory rather than as the root.
 */
export function pullRequestDirectoryOf(project: AssignableProject): string | null {
  const identity = project.repositoryIdentity;
  if (!identity || sourceControlClients.get(identity.provider).pathScopedLists !== true)
    return null;
  if (project.workspaceRoot === undefined || identity.rootPath === undefined) return null;
  if (workspaceRelativeFilePath(project.workspaceRoot, identity.rootPath) === ".") return null;
  return repositoryPathScope(identity.rootPath, project.workspaceRoot) ?? project.workspaceRoot;
}

function repositoryKey(project: AssignableProject): string | undefined {
  return project.repositoryIdentity?.canonicalKey?.toLowerCase();
}

export function assignProjectsToEnvironments(
  projects: ReadonlyArray<AssignableProject>,
  environmentIds: ReadonlyArray<EnvironmentId>,
  preferredEnvironmentId?: EnvironmentId | null,
): Map<EnvironmentId, ProjectId[]> {
  const rank = new Map(environmentIds.map((id, index) => [id, index] as const));
  // A server holding only a repository's directory projects would list only those directories'
  // pull requests, so a server that also holds the repository's root lists it instead.
  const holdsRoot = new Set<string>();
  const rootAnywhere = new Set<string>();
  const hasDirectories = new Set<string>();
  for (const project of projects) {
    const key = repositoryKey(project);
    if (!key) continue;
    if (pullRequestDirectoryOf(project) === null) {
      holdsRoot.add(`${key} ${project.environmentId}`);
      rootAnywhere.add(key);
    } else hasDirectories.add(key);
  }
  // With no root anywhere, each directory is listed from a server holding it, or its pull
  // requests would be on no list.
  const ownerKey = (project: AssignableProject) => {
    const key = repositoryKey(project);
    return key && hasDirectories.has(key) && !rootAnywhere.has(key)
      ? `${key} ${pullRequestDirectoryOf(project)}`
      : key;
  };
  const owner = new Map<string, EnvironmentId>();
  for (const project of projects) {
    const key = ownerKey(project);
    if (!key) continue;
    const environmentRank = rank.get(project.environmentId);
    if (environmentRank === undefined) continue;
    const current = owner.get(key);
    if (hasDirectories.has(key) && current !== undefined) {
      const ownsRoot = holdsRoot.has(`${key} ${current}`);
      const offersRoot = holdsRoot.has(`${key} ${project.environmentId}`);
      if (ownsRoot !== offersRoot) {
        if (offersRoot) owner.set(key, project.environmentId);
        continue;
      }
    }
    if (current === undefined) {
      owner.set(key, project.environmentId);
      continue;
    }
    if (current === preferredEnvironmentId) continue;
    if (
      project.environmentId === preferredEnvironmentId ||
      environmentRank < (rank.get(current) ?? Number.MAX_SAFE_INTEGER)
    ) {
      owner.set(key, project.environmentId);
    }
  }
  const assignment = new Map<EnvironmentId, ProjectId[]>();
  for (const project of projects) {
    if (!rank.has(project.environmentId)) continue;
    const key = ownerKey(project);
    if (key && owner.get(key) !== project.environmentId) continue;
    const listed = assignment.get(project.environmentId);
    if (listed === undefined) assignment.set(project.environmentId, [project.id]);
    else listed.push(project.id);
  }
  return assignment;
}

export interface PickableEnvironment {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly label: string;
  readonly machine?: EnvironmentMachineKind;
}

export function resolvePickableEnvironments(
  current: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId },
  projects: ReadonlyArray<AssignableProject & { readonly workspaceRoot: string }>,
  environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly machine?: EnvironmentMachineKind;
  }>,
): ReadonlyArray<PickableEnvironment> {
  const own = projects.find(
    (project) =>
      project.environmentId === current.environmentId && project.id === current.projectId,
  );
  const key = own === undefined ? undefined : repositoryKey(own);
  const ownEnvironment = environments.find(
    (environment) => environment.environmentId === current.environmentId,
  );
  if (own === undefined || !key || ownEnvironment === undefined) return [];
  const others = environments.flatMap((environment) => {
    if (environment.environmentId === current.environmentId) return [];
    const copy = projects.find(
      (project) =>
        project.environmentId === environment.environmentId && repositoryKey(project) === key,
    );
    return copy === undefined
      ? []
      : [
          {
            environmentId: environment.environmentId,
            projectId: copy.id,
            workspaceRoot: copy.workspaceRoot,
            label: environment.label,
            ...(environment.machine === undefined ? {} : { machine: environment.machine }),
          },
        ];
  });
  if (others.length === 0) return [];
  return [
    {
      environmentId: current.environmentId,
      projectId: own.id,
      workspaceRoot: own.workspaceRoot,
      label: ownEnvironment.label,
      ...(ownEnvironment.machine === undefined ? {} : { machine: ownEnvironment.machine }),
    },
    ...others,
  ];
}
