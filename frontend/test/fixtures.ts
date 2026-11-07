import { expect, test as base, type Page } from "@playwright/test";

/**
 * A recording EIP-1193 wallet. It answers account and chain queries, refuses
 * every signing or sending method, and counts each one it sees — so a test can
 * prove the app never asked for a transaction. External network requests are
 * aborted (chain-logo CDN, public RPCs) and any JSON-RPC body that tries to
 * broadcast is recorded too.
 */

export const SEND_METHODS = /^(eth_sendTransaction|eth_signTransaction|eth_sendRawTransaction|eth_sign|personal_sign|eth_signTypedData(_v\d)?|wallet_sendCalls)$/;

export interface WalletLog {
  calls: string[];
  refused: string[];
}

export async function installWallet(page: Page, chainIdHex = "0x2105", behavior: "normal" | "missing" | "rejected" = "normal") {
  await page.addInitScript(({ chain, behavior }) => {
    const log = { calls: [] as string[], refused: [] as string[] };
    (window as unknown as { __wallet: typeof log }).__wallet = log;
    const accounts = ["0x1111111111111111111111111111111111111111"];
    let chainId = chain;
    let missing = behavior === "missing";
    const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
    const emit = (e: string, v: unknown) => (listeners[e] ?? []).forEach((f) => f(v));
    const provider = {
      isMetaMask: true,
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        log.calls.push(method);
        switch (method) {
          case "eth_requestAccounts":
          case "eth_accounts":
            return accounts;
          case "eth_chainId":
            return chainId;
          case "net_version":
            return String(parseInt(chainId, 16));
          case "wallet_switchEthereumChain":
            if (behavior === "rejected") throw Object.assign(new Error("User declined switch"), { code: 4001 });
            if (missing) { missing = false; throw Object.assign(new Error("Unknown chain"), { code: 4902 }); }
            chainId = (params?.[0] as { chainId: string }).chainId;
            emit("chainChanged", chainId);
            return null;
          case "wallet_requestPermissions":
          case "wallet_getPermissions":
            return [{ parentCapability: "eth_accounts" }];
          case "eth_blockNumber":
            return "0x1";
          case "eth_getBalance":
            return "0x0";
          case "eth_call":
            return "0x";
          default:
            if (/^(eth_send|eth_sign|personal_sign|wallet_sendCalls)/.test(method)) {
              log.refused.push(method);
              throw Object.assign(new Error("test wallet refuses to sign"), { code: 4001 });
            }
            return null;
        }
      },
      on: (e: string, f: (...a: unknown[]) => void) => void (listeners[e] ??= []).push(f),
      removeListener: (e: string, f: (...a: unknown[]) => void) => void (listeners[e] = (listeners[e] ?? []).filter((x) => x !== f)),
    };
    (window as unknown as { ethereum: typeof provider }).ethereum = provider;
  }, { chain: chainIdHex, behavior });
}

export const test = base.extend<{ broadcasts: string[] }>({
  broadcasts: async ({ page }, use) => {
    const seen: string[] = [];
    await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, async (route) => {
      const body = route.request().postData() ?? "";
      if (/eth_sendRawTransaction|eth_sendTransaction/.test(body)) seen.push(body.slice(0, 200));
      await route.abort();
    });
    await use(seen);
  },
});

export async function walletLog(page: Page): Promise<WalletLog> {
  return page.evaluate(() => (window as unknown as { __wallet?: WalletLog }).__wallet ?? { calls: [], refused: [] });
}

export async function expectNoTransactionRequests(page: Page, broadcasts: string[]) {
  const log = await walletLog(page);
  expect(log.calls.filter((m) => SEND_METHODS.test(m)), "wallet signing/sending calls").toEqual([]);
  expect(log.refused, "refused wallet calls").toEqual([]);
  expect(broadcasts, "raw transaction broadcasts").toEqual([]);
}

/** The network note under the header (role=status). */
export const note = (page: Page) => page.getByTestId("network-note");

export { expect };
