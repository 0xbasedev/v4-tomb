/**
 * Seam — the divider. A hairline with a small faceted glyph at its centre,
 * like a fault line in obsidian. Replaces the Art Deco rule trio.
 */
export function Seam({ withGlyph = true, className = "" }: { withGlyph?: boolean; className?: string }) {
  if (!withGlyph) return <div aria-hidden className={`seam ${className}`} />;
  return (
    <div aria-hidden className={`flex items-center gap-4 ${className}`}>
      <span className="seam flex-1" />
      <svg width="14" height="14" viewBox="0 0 14 14" className="text-ember/70">
        <path d="M7 1 13 7 7 13 1 7Z" fill="none" stroke="currentColor" strokeWidth="1.2" />
        <path d="M7 4.5 9.5 7 7 9.5 4.5 7Z" fill="currentColor" />
      </svg>
      <span className="seam flex-1" />
    </div>
  );
}
