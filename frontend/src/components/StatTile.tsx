import type { ReactNode } from "react";

import { AnimatedNumber } from "@/components/fx/AnimatedNumber";

/**
 * StatTile — one number, one label, one line of context.
 *
 * Pass `numeric` to get a counting tween (preferred for live values); pass a
 * plain `value` string for things that aren't numbers ("Open", "6 epochs").
 * `tone` tints the value only — the tile itself stays neutral so a grid of
 * tiles never competes with the page's primary action.
 */

interface StatTileProps {
  label: string;
  value?: string;
  numeric?: number | null;
  format?: (n: number) => string;
  unit?: string;
  hint?: ReactNode;
  tone?: "default" | "ember" | "spectre" | "amethyst" | "ok" | "bad" | "warn";
  icon?: ReactNode;
  className?: string;
}

const TONE: Record<NonNullable<StatTileProps["tone"]>, string> = {
  default: "text-bone",
  ember: "text-ember-hot",
  spectre: "text-spectre",
  amethyst: "text-amethyst",
  ok: "text-ok",
  bad: "text-bad",
  warn: "text-warn",
};

export function StatTile({
  label,
  value,
  numeric,
  format,
  unit,
  hint,
  tone = "default",
  icon,
  className = "",
}: StatTileProps) {
  return (
    <div data-reveal className={`panel panel-hover flex flex-col gap-3 p-5 ${className}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="label">{label}</span>
        {icon}
      </div>
      <div className={`flex flex-wrap items-baseline gap-x-2 gap-y-1 font-display text-[22px] font-semibold leading-none tracking-[-0.03em] sm:text-[26px] md:text-[30px] ${TONE[tone]}`}>
        {numeric !== undefined ? (
          <AnimatedNumber value={numeric} format={format} className="font-display tracking-[-0.03em]" />
        ) : (
          <span className="min-w-0 break-words">{value ?? "—"}</span>
        )}
        {unit && <span className="font-mono text-xs font-medium tracking-wider text-ash">{unit}</span>}
      </div>
      {hint && <div className="text-[13px] leading-snug text-ash">{hint}</div>}
    </div>
  );
}
