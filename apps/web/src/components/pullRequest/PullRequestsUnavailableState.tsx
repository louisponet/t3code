import { RefreshIcon } from "~/components/ui/refresh-icon";
import { ExternalLinkIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { PullRequestGlyph } from "./pullRequestIcons";

export function PullRequestsUnavailableState({
  title = "Could not load pull requests",
  error,
  onRetry,
  refreshing = false,
  hostLink,
}: {
  title?: string;
  error: string;
  onRetry?: () => void;
  refreshing?: boolean;
  hostLink?: { readonly url: string; readonly label: string };
}) {
  return (
    <Empty className="scrollbar-gutter-both min-h-0 justify-center-safe overflow-y-auto [&>*]:shrink-0">
      <EmptyMedia variant="icon">
        <PullRequestGlyph.pullRequest />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        {/* The caller names the fix — update the environment, install gh, sign in — so this
            shows its message rather than trying to infer one from the failure text. */}
        <EmptyDescription>{error}</EmptyDescription>
      </EmptyHeader>
      {onRetry || hostLink ? (
        <div className="flex flex-wrap justify-center gap-2">
          {onRetry ? (
            <Button
              size="sm"
              variant="outline"
              onClick={onRetry}
              disabled={refreshing}
              aria-busy={refreshing}
            >
              <RefreshIcon size="sm" refreshing={refreshing} />
              Retry
            </Button>
          ) : null}
          {hostLink ? (
            <Button
              size="sm"
              variant="outline"
              render={<a href={hostLink.url} target="_blank" rel="noopener noreferrer" />}
            >
              <ExternalLinkIcon aria-hidden className="size-3.5" />
              Open on {hostLink.label}
            </Button>
          ) : null}
        </div>
      ) : null}
    </Empty>
  );
}
