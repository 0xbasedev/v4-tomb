import { useId } from "react";

const center = { x: 180, y: 153 };
function point(radius: number, degrees: number) {
  const radians = degrees * Math.PI / 180;
  return [center.x + Math.cos(radians) * radius, center.y + Math.sin(radians) * radius];
}
const arc = (radius: number, from: number, to: number) =>
  `M ${point(radius, from).join(" ")} A ${radius} ${radius} 0 0 1 ${point(radius, to).join(" ")}`;

export function Gauge({ sample }: { sample?: number }) {
  const gradient = useId();
  const fraction = Math.min(1, Math.max(0, ((sample ?? 1) - 0.8) / 0.4));
  const needle = point(92, 190 + fraction * 160);
  return (
    <div className="gauge">
      <svg viewBox="0 0 360 204" aria-hidden="true">
        <defs>
          <linearGradient id={gradient}>
            <stop stopColor="#9b72ff" />
            <stop offset=".52" stopColor="#e1a66f" />
            <stop offset="1" stopColor="#ff6a2b" />
          </linearGradient>
        </defs>
        <path d={arc(109, 190, 350)} className="gauge-track" />
        <path d={arc(109, 190, 350)} stroke={`url(#${gradient})`} className="gauge-arc" />
        {Array.from({ length: 33 }, (_, index) => {
          const degree = 190 + index * 5;
          const [x1, y1] = point(123, degree);
          const [x2, y2] = point(index % 4 === 0 ? 132 : 127, degree);
          return <line key={degree} x1={x1} x2={x2} y1={y1} y2={y2} className={index % 4 === 0 ? "tick major" : "tick"} />;
        })}
        <line x1={center.x} y1={center.y} x2={needle[0]} y2={needle[1]} className="gauge-needle" />
        <circle cx={center.x} cy={center.y} r="7" className="gauge-hub" />
        <text x="35" y="174" textAnchor="middle">$0.80</text>
        <text x="325" y="174" textAnchor="middle">$1.20</text>
      </svg>
      <strong>{sample === undefined ? "$1.00" : `$${sample.toFixed(4)}`}</strong>
      <span>{sample === undefined ? "Target peg · no live feed" : "Simulated xTOMB price"}</span>
    </div>
  );
}
