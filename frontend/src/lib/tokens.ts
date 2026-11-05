/**
 * Token registry — what the dapp lets you hold, trade or stake.
 *
 * Official pairs are xTOMB/USDC and xSHARE/USDC, each a Uniswap v4 pool with
 * its own Fire Tax hook. Their LP tokens are the vault shares minted by
 * MasonryLevelUsdcVault and MasonrySquareUsdcVault (one fixed tick range
 * each, redeemable for both underlying tokens). ETH is listed so the picker
 * can explain why it isn't routable; xBOND is a planned preview.
 */

export type TokenId = "xTOMB" | "xSHARE" | "USDC" | "xTOMB-USDC" | "xSHARE-USDC" | "ETH" | "xBOND";

export type TokenKind = "native" | "base" | "protocol" | "lp" | "planned";

export interface TokenDef {
  id: TokenId;
  symbol: string;
  name: string;
  decimals: number;
  kind: TokenKind;
  /** For LPs: the two underlying tokens (asset first, USDC second). */
  pair?: [TokenId, TokenId];
  /** Contract name behind it, for the review screens. */
  contract?: string;
}

export const TOKENS: Record<TokenId, TokenDef> = {
  xTOMB: { id: "xTOMB", symbol: "xTOMB", name: "xTomb · peg asset", decimals: 18, kind: "protocol", contract: "LEVEL" },
  xSHARE: { id: "xSHARE", symbol: "xSHARE", name: "xShare · share asset", decimals: 18, kind: "protocol", contract: "SQUARE" },
  USDC: { id: "USDC", symbol: "USDC", name: "USD Coin (native, Circle)", decimals: 6, kind: "base" },
  "xTOMB-USDC": {
    id: "xTOMB-USDC",
    symbol: "xTOMB-USDC LP",
    name: "xTOMB / USDC vault shares",
    decimals: 18,
    kind: "lp",
    pair: ["xTOMB", "USDC"],
    contract: "MasonryLevelUsdcVault",
  },
  "xSHARE-USDC": {
    id: "xSHARE-USDC",
    symbol: "xSHARE-USDC LP",
    name: "xSHARE / USDC vault shares",
    decimals: 18,
    kind: "lp",
    pair: ["xSHARE", "USDC"],
    contract: "MasonrySquareUsdcVault",
  },
  ETH: { id: "ETH", symbol: "ETH", name: "Ether — no official pool", decimals: 18, kind: "native" },
  xBOND: { id: "xBOND", symbol: "xBOND", name: "xBond — planned", decimals: 18, kind: "planned" },
};

export const isLp = (id: TokenId) => TOKENS[id].kind === "lp";

/**
 * The Swap page's token rail, three columns so each LP sits under its token:
 *   xTOMB        xSHARE        USDC
 *   xTOMB·USDC   xSHARE·USDC   ETH
 */
export const SWAP_TOKENS: TokenId[] = ["xTOMB", "xSHARE", "USDC", "xTOMB-USDC", "xSHARE-USDC", "ETH"];

/** Compact label for chips ("xTOMB·USDC" for an LP). */
export const shortLabel = (id: TokenId) => (TOKENS[id].pair ? `${TOKENS[id].pair![0]}·${TOKENS[id].pair![1]}` : TOKENS[id].symbol);
