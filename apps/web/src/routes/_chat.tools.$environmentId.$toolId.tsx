import type { EnvironmentId, EnvironmentToolId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { ToolPage } from "../components/tools/ToolPage";

function ToolRouteView() {
  const { environmentId, toolId } = Route.useParams();
  // Keyed so switching tools starts each page's launch and attach afresh.
  return (
    <ToolPage
      key={`${environmentId}/${toolId}`}
      environmentId={environmentId as EnvironmentId}
      toolId={toolId as EnvironmentToolId}
    />
  );
}

export const Route = createFileRoute("/_chat/tools/$environmentId/$toolId")({
  component: ToolRouteView,
});
