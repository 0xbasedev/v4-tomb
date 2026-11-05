export interface WalletSession {
  chainId?: number;
  address?: `0x${string}`;
}

export function sameWalletSession(origin: WalletSession | null, current: WalletSession): boolean {
  return !!origin?.address && origin.chainId !== undefined && origin.chainId === current.chainId
    && origin.address.toLowerCase() === current.address?.toLowerCase();
}
