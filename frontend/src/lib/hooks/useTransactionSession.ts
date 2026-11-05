import { useRef } from "react";
import { useAccount } from "wagmi";
import { sameWalletSession, type WalletSession } from "../walletSession";

/** Keep every approval/write and receipt in a pipeline on its originating wallet. */
export function useTransactionSession() {
  const { chainId, address } = useAccount();
  const current = useRef<WalletSession>({});
  current.current = { chainId, address };
  const origin = useRef<WalletSession | null>(null);
  return {
    begin() { origin.current = { ...current.current }; },
    valid() { return sameWalletSession(origin.current, current.current); },
    get chainId() { return origin.current?.chainId; },
    get account() { return origin.current?.address; },
  };
}
