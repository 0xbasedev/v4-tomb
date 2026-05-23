/**
 * RuleTrio — Art Deco section divider. Three horizontal lines (thin-thick-thin) in
 * metallic gold, optionally with a centered ornamental diamond between them.
 *
 * Per docs/skill-art-deco.md: every section boundary uses a rule trio, never a plain
 * <hr>. Rule trios come "in threes: a thick rule flanked by two thin rules."
 */

export function RuleTrio({ withDiamond = true, className = "" }: { withDiamond?: boolean; className?: string }) {
  if (!withDiamond) {
    return <div className={`rule-trio mx-auto max-w-md ${className}`} aria-hidden />;
  }

  return (
    <div className={`rule-trio-diamond mx-auto max-w-md ${className}`} aria-hidden>
      <span aria-hidden className="block h-3 w-3 rotate-45 bg-deco-gold" />
    </div>
  );
}
