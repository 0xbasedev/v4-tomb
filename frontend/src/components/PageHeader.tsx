import type { ReactNode } from "react";

import { TokenIcon, type TokenSymbol } from "@/components/TokenIcon";

/**
 * PageHeader — every app route opens the same way: an eyebrow that says where
 * you are in the protocol, a title, one sentence of purpose, and an optional
 * right-hand slot for the page's live status. Consistency here is what lets
 * the *content* below vary without the user feeling lost.
 */
interface PageHeaderProps {
  eyebrow: string;
  title: ReactNode;
  lede: ReactNode;
  token?: TokenSymbol;
  aside?: ReactNode;
}

export function PageHeader({ eyebrow, title, lede, token, aside }: PageHeaderProps) {
  return (
    <header className="mx-auto w-full max-w-7xl px-4 pb-8 pt-10 md:px-8 md:pb-12 md:pt-16">
      <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-2xl">
          <div data-reveal className="mb-4 flex items-center gap-3">
            {token && <TokenIcon symbol={token} size={24} />}
            <span className="label">{eyebrow}</span>
          </div>
          <h1 data-reveal className="text-section text-balance text-bone">
            {title}
          </h1>
          <p data-reveal className="mt-4 max-w-xl text-subhead text-bone-dim">
            {lede}
          </p>
        </div>
        {aside && (
          <div data-reveal className="w-full lg:w-auto lg:min-w-[340px]">
            {aside}
          </div>
        )}
      </div>
    </header>
  );
}

/** Section heading used inside pages. */
export function SectionTitle({ kicker, title, right }: { kicker?: string; title: string; right?: ReactNode }) {
  return (
    <div data-reveal className="mb-5 flex items-end justify-between gap-4">
      <div>
        {kicker && <div className="label mb-2">{kicker}</div>}
        <h2 className="font-display text-xl font-semibold tracking-[-0.02em] text-bone md:text-2xl">{title}</h2>
      </div>
      {right}
    </div>
  );
}
