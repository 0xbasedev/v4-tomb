/**
 * Skeleton — Art Deco loading placeholder. Renders an inline gold-bordered
 * shimmer block sized to the eventual content. Used in place of "—" for
 * the first-paint moment before the wagmi multicalls settle.
 */
interface SkeletonProps {
  /** CSS width — pass "8ch" for character-width or "100%" for full block. */
  width?: string;
  /** CSS height — defaults to "1em". */
  height?: string;
  className?: string;
}

export function Skeleton({ width = "6ch", height = "1em", className = "" }: SkeletonProps) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={`inline-block animate-pulse bg-deco-gold/10 align-middle ${className}`}
      style={{ width, height }}
    />
  );
}
