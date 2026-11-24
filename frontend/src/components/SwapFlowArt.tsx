import { useId } from "react";

/** Decorative two-way liquidity route; independent of wallet and quote state. */
export function SwapFlowArt() {
  const id = useId().replaceAll(":", "");
  return <div className="swap-flow-art mx-auto w-full max-w-[370px]">
    <svg viewBox="0 0 370 250" fill="none" className="w-full" role="img" aria-label="Two-way route between tokens and wrapped liquidity">
      <defs>
        <radialGradient id={`${id}halo`}><stop stopColor="#6366f1" stopOpacity=".16"/><stop offset="1" stopColor="#6366f1" stopOpacity="0"/></radialGradient>
        <linearGradient id={`${id}metal`} x1="30" y1="70" x2="310" y2="190" gradientUnits="userSpaceOnUse"><stop stopColor="#2a1f5e"/><stop offset=".5" stopColor="#0d0e1f"/><stop offset="1" stopColor="#1e3a8a"/></linearGradient>
        <linearGradient id={`${id}light`}><stop stopColor="#c4b5fd"/><stop offset="1" stopColor="#3b82f6"/></linearGradient>
      </defs>
      <ellipse cx="185" cy="125" rx="180" ry="120" fill={`url(#${id}halo)`}/>
      <path d="M107 80c45-55 114-55 158 0m-16-3 16 3-2-17M264 169c-45 55-114 55-158 0m16 3-16-3 2 17" stroke="#818cf8" strokeOpacity=".4" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      <path className="swap-flow-current" d="M107 80c45-55 114-55 158 0M264 169c-45 55-114 55-158 0" stroke="#bfdbfe" strokeWidth="2.5" strokeDasharray="3 22" strokeLinecap="round"/>
      <g className="swap-flow-lp">
        <path d="m85 76 47 27v54l-47 27-47-27v-54Z" fill={`url(#${id}metal)`} stroke="#818cf8" strokeOpacity=".7"/>
        <path d="m85 86 38 22v43l-38 22-38-22v-43Z" stroke="#a5b4fc" strokeOpacity=".2"/>
        <circle cx="76" cy="125" r="17" fill="#17163a" stroke="#bfdbfe" strokeOpacity=".7"/>
        <circle cx="94" cy="135" r="17" fill="#1e2a66" stroke="#bfdbfe" strokeOpacity=".7"/>
        <path d="m74 116-6 11h12Zm20 10-5 9 5 9 5-9Z" stroke="#dbeafe" strokeWidth="1.5"/>
      </g>
      <g className="swap-flow-token">
        <ellipse cx="281" cy="133" rx="38" ry="44" fill="#111533" stroke="#4338ca" strokeWidth="5"/>
        <ellipse cx="276" cy="128" rx="38" ry="44" fill={`url(#${id}metal)`} stroke={`url(#${id}light)`} strokeWidth="2"/>
        <ellipse cx="276" cy="128" rx="29" ry="35" stroke="#a5b4fc" strokeOpacity=".3"/>
        <path d="m276 103 13 25-13 25-13-25 13-25Zm-13 25 13 5 13-5m-13 5v20" stroke="#dbeafe" strokeWidth="1.5" strokeLinejoin="round"/>
      </g>
      <circle cx="185" cy="124" r="20" fill="#0f1024" stroke="#818cf8" strokeOpacity=".2"/>
      <path d="M174 119h22m-5-5 5 5-5 5m5 5h-22m5-5-5 5 5 5" stroke="#c7d2fe" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      <text x="85" y="213" textAnchor="middle" fill="#c7d2fe" fontFamily="monospace" fontSize="10" letterSpacing="2">WRAPPED LP</text>
      <text x="278" y="213" textAnchor="middle" fill="#c7d2fe" fontFamily="monospace" fontSize="10" letterSpacing="2">TOKENS</text>
    </svg>
  </div>;
}
