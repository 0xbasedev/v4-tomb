/**
 * TabBar — Art Deco tab navigation. Gold-bordered pills (no rounding); active tab
 * fills with gold + inverts text color. Used in The Vault for switching between
 * Genesis / Main / Share pools.
 *
 * Centered on the horizontal axis. The label "ornament numeral" is rendered
 * above each tab label (I / II / III).
 */

interface TabItem {
  id: string;
  numeral: string;
  label: string;
  sublabel?: string;
}

interface TabBarProps {
  items: TabItem[];
  active: string;
  onChange: (id: string) => void;
}

export function TabBar({ items, active, onChange }: TabBarProps) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-wrap items-stretch justify-center border border-deco-gold/40">
      {items.map((item, i) => {
        const isActive = item.id === active;
        const isLast = i === items.length - 1;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onChange(item.id)}
            className={`group relative flex flex-1 flex-col items-center gap-1 px-6 py-5 text-center transition-colors duration-200 ${
              !isLast ? "border-r border-deco-gold/40" : ""
            } ${
              isActive
                ? "bg-deco-gold text-deco-ground"
                : "bg-deco-ground text-deco-gold hover:bg-deco-ground-soft"
            }`}
          >
            <span
              className={`font-ornament text-lg font-bold ${
                isActive ? "text-deco-ground" : "text-deco-gold"
              }`}
              style={{ letterSpacing: "0.2em" }}
            >
              {item.numeral}
            </span>
            <span
              className="label-deco"
              style={{ color: isActive ? "currentColor" : undefined }}
            >
              {item.label}
            </span>
            {item.sublabel && (
              <span className="font-body text-xs italic opacity-75">{item.sublabel}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
