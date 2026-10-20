import type {
  EnvironmentToolBadge,
  EnvironmentToolStatus,
  EnvironmentToolTone,
} from "@t3tools/contracts";

import { useClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { formatShortTimestamp } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const TONE_BADGE_VARIANT = {
  good: "success",
  info: "info",
  warn: "warning",
  alert: "error",
  muted: "secondary",
} as const satisfies Record<EnvironmentToolTone, string>;

const TONE_DOT_CLASS: Record<EnvironmentToolTone, string> = {
  good: "bg-success",
  info: "bg-info",
  warn: "bg-warning",
  alert: "bg-destructive",
  muted: "bg-muted-foreground/50",
};

const TONE_TEXT_CLASS: Record<EnvironmentToolTone, string> = {
  good: "text-success-foreground",
  info: "text-info-foreground",
  warn: "text-warning-foreground",
  alert: "text-destructive-foreground",
  muted: "text-muted-foreground",
};

export function ToolToneDot({ tone }: { tone: EnvironmentToolTone }) {
  return (
    <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT_CLASS[tone])} />
  );
}

function BadgeMark({ badge }: { badge: EnvironmentToolBadge }) {
  return badge.glyph ? (
    <span aria-hidden className="shrink-0">
      {badge.glyph}
    </span>
  ) : (
    <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />
  );
}

/** Pending and missing statuses render nothing; nothing here animates. */
export function ToolStatusBadge(props: {
  status: EnvironmentToolStatus | undefined;
  size: "row" | "header";
  description?: string | undefined;
}) {
  const { status } = props;
  if (status === undefined || status.state === "pending") return null;
  const layout = props.size === "row" ? "min-w-0 max-w-[45%] shrink" : "min-w-0 shrink";

  const trigger =
    status.state === "ready" ? (
      <Badge
        variant={TONE_BADGE_VARIANT[status.badge.tone]}
        size={props.size === "row" ? "sm" : "default"}
        className={layout}
      >
        <BadgeMark badge={status.badge} />
        <span className="truncate">{status.badge.headline}</span>
      </Badge>
    ) : (
      <span
        className={cn(
          "flex items-center gap-1 text-muted-foreground/70",
          props.size === "row" ? "text-3xs" : "text-xs",
          layout,
        )}
      >
        <ToolToneDot tone="muted" />
        {status.lastBadge ? <span className="truncate">{status.lastBadge.headline}</span> : null}
      </span>
    );

  return (
    <Tooltip>
      <TooltipTrigger delay={150} render={trigger} />
      <TooltipPopup side="top">
        <ToolStatusTooltip status={status} description={props.description} />
      </TooltipPopup>
    </Tooltip>
  );
}

function ToolStatusTooltip({
  status,
  description,
}: {
  status: Exclude<EnvironmentToolStatus, { state: "pending" }>;
  description: string | undefined;
}) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const badge = status.state === "ready" ? status.badge : status.lastBadge;
  const hiddenItems = badge ? badge.total - badge.items.length : 0;
  return (
    <div className="flex flex-col gap-1 py-0.5">
      {description ? <p className="text-muted-foreground">{description}</p> : null}
      {status.state === "unavailable" ? (
        <p className="text-destructive-foreground">{status.reason}</p>
      ) : null}
      {badge ? (
        <>
          <p className={cn(status.state === "unavailable" && "text-muted-foreground")}>
            {badge.headline}
          </p>
          {badge.detail.length > 0 ? (
            <p className="text-muted-foreground">{badge.detail.join(" · ")}</p>
          ) : null}
          {badge.items.length > 0 ? (
            <ul className="flex flex-col gap-0.5">
              {badge.items.map((item, index) => (
                // oxlint-disable-next-line react/no-array-index-key -- a static snapshot whose items have no ids and may repeat.
                <li key={index} className="flex min-w-0 items-baseline gap-1.5">
                  <span aria-hidden className={cn("shrink-0", TONE_TEXT_CLASS[item.tone])}>
                    {item.glyph ?? "•"}
                  </span>
                  <span className="min-w-0">{item.text}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {hiddenItems > 0 ? <p className="text-muted-foreground">+{hiddenItems} more</p> : null}
        </>
      ) : null}
      <p className="text-muted-foreground">
        since {formatShortTimestamp(status.since, timestampFormat)}
      </p>
    </div>
  );
}
