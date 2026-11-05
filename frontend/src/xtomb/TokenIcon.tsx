const icons = {
  xTOMB: "xtomb.svg",
  xSHARE: "xshare.svg",
  ETH: "eth.png",
  USDC: "usdc.svg",
} as const;

export function TokenIcon({ token }: { token: keyof typeof icons }) {
  return <img className="token-icon" src={`/tokens/${icons[token]}`} width="32" height="32" alt="" />;
}
