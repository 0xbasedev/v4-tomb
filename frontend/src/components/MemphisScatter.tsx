/**
 * MemphisScatter — background layer of scattered 80s geometric shapes.
 *
 * Per docs/eighties-design skill:
 *   - 6-12 shapes per screen
 *   - Shape types: filled circle, filled triangle, squiggle, plus sign, diagonal stripe
 *   - Colors: at least 4 different, never adjacent on color wheel
 *   - Rotation: 0deg, 15deg, 30deg, 45deg only
 *   - Scale range 3:1
 *
 * Pointer-events: none so it never blocks content interaction.
 */

type ShapeKind = "circle" | "triangle" | "square" | "plus";

interface Shape {
  kind: ShapeKind;
  x: string; // CSS left
  y: string; // CSS top
  size: number;
  color: string;
  rotate: 0 | 15 | 30 | 45;
}

// A scatter calibrated for the Miami palette — 8 shapes, rule-of-thirds-ish placement.
const MIAMI_SCATTER: Shape[] = [
  { kind: "circle", x: "6%", y: "8%", size: 60, color: "#ff1493", rotate: 0 },
  { kind: "triangle", x: "14%", y: "62%", size: 72, color: "#00ced1", rotate: 30 },
  { kind: "plus", x: "82%", y: "12%", size: 56, color: "#ffe600", rotate: 0 },
  { kind: "circle", x: "90%", y: "55%", size: 40, color: "#ff6600", rotate: 0 },
  { kind: "square", x: "70%", y: "78%", size: 48, color: "#cc00ff", rotate: 45 },
  { kind: "triangle", x: "4%", y: "84%", size: 36, color: "#ffe600", rotate: 15 },
  { kind: "circle", x: "52%", y: "5%", size: 32, color: "#00ced1", rotate: 0 },
  { kind: "plus", x: "44%", y: "88%", size: 44, color: "#ff1493", rotate: 15 },
];

export function MemphisScatter({ shapes = MIAMI_SCATTER }: { shapes?: Shape[] }) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      {shapes.map((s, i) => (
        <ShapeEl key={i} {...s} />
      ))}
    </div>
  );
}

function ShapeEl({ kind, x, y, size, color, rotate }: Shape) {
  const baseStyle: React.CSSProperties = {
    position: "absolute",
    left: x,
    top: y,
    width: size,
    height: size,
    transform: `rotate(${rotate}deg)`,
  };

  if (kind === "circle") {
    return (
      <div
        style={{
          ...baseStyle,
          background: color,
          borderRadius: "50%",
        }}
      />
    );
  }

  if (kind === "square") {
    return <div style={{ ...baseStyle, background: color }} />;
  }

  if (kind === "triangle") {
    return (
      <div
        style={{
          ...baseStyle,
          width: 0,
          height: 0,
          background: "transparent",
          borderLeft: `${size / 2}px solid transparent`,
          borderRight: `${size / 2}px solid transparent`,
          borderBottom: `${size}px solid ${color}`,
        }}
      />
    );
  }

  // plus sign
  return (
    <div style={baseStyle}>
      <div
        style={{
          position: "absolute",
          left: "0",
          top: `${size / 2 - 6}px`,
          width: size,
          height: 12,
          background: color,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: `${size / 2 - 6}px`,
          top: 0,
          width: 12,
          height: size,
          background: color,
        }}
      />
    </div>
  );
}
