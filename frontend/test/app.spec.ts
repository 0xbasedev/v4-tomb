import { test, expect, type Page } from "@playwright/test";

import { sameWalletSession } from "../src/lib/walletSession";

/**
 * These run against the shipped manifest (config/networks.json), which has no
 * deployment. They check that the app is honest about that, that every route
 * holds together at desktop and phone widths, and that the theme has no warm
 * accent anywhere.
 */

const ROUTES = ["/", "/dashboard", "/genesis", "/farm", "/masonry", "/swap", "/docs", "/admin"];
const REDIRECTS: Record<string, string> = {
  "/club": "/masonry",
  "/vault": "/farm",
  "/farms": "/farm",
  "/bonds": "/dashboard",
  "/notes": "/dashboard",
  "/auction": "/dashboard",
  "/wizard": "/dashboard",
  "/manager": "/dashboard",
  "/no-such-page": "/dashboard",
};

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  return errors;
}

for (const width of [1280, 390]) {
  test(`every route renders without errors or overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const errors = watchErrors(page);
    for (const route of ROUTES) {
      await page.goto(route);
      await expect(page.locator("h1").first()).toBeVisible();
      await expect(page.getByTestId("network-note")).toContainText("no protocol deployment configured");
      expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), `${route} overflows at ${width}px`).toBe(false);
    }
    expect(errors).toEqual([]);
  });
}

test("old and removed paths redirect", async ({ page }) => {
  for (const [from, to] of Object.entries(REDIRECTS)) {
    await page.goto(from);
    await expect(page, `${from} should land on ${to}`).toHaveURL(new RegExp(`${to}$`));
    await expect(page.locator("h1").first()).toBeVisible();
  }
});

test("undeployed pages say so and show no live numbers", async ({ page }) => {
  for (const route of ["/dashboard", "/genesis", "/farm", "/masonry", "/swap", "/admin"]) {
    await page.goto(route);
    await expect(page.getByTestId("not-deployed")).toContainText("Not deployed on this network");
  }
  await page.goto("/dashboard");
  // The header readout carries dashes, not sample prices.
  await expect(page.getByTestId("ticker")).toHaveText(/xTOMB\s*—.*xSHARE\s*—.*Sell tax\s*—.*Epoch\s*—/);
});

test("navigation uses the xTOMB / xSHARE / xROOM names and drops removed features", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.goto("/dashboard");
  const header = page.locator("header").first();
  await expect(header).toContainText("xTOMB");
  await expect(header).toContainText("xSHARE");
  const nav = page.getByRole("navigation", { name: "Primary" });
  await expect(nav.getByRole("link", { name: "xROOM" })).toHaveAttribute("href", "/masonry");
  for (const label of ["Dashboard", "Genesis", "Farm", "Swap"]) await expect(nav.getByRole("link", { name: label })).toBeVisible();
  for (const region of [page.getByRole("banner"), page.getByRole("contentinfo")]) {
    await expect(region).not.toContainText(/auction|bridge|bond|wizard|manager|pass/i);
  }
});

/** Orange / amber: hue 8°–65° with real saturation. Greys and near-blacks are not colours. */
const WARM = `(rgb) => {
  const m = /rgba?\\(([\\d.]+)[, ]+([\\d.]+)[, ]+([\\d.]+)(?:[,/ ]+([\\d.]+))?/.exec(rgb);
  if (!m) return false;
  const [r, g, b] = [m[1], m[2], m[3]].map((v) => Number(v) / 255);
  if (m[4] !== undefined && Number(m[4]) === 0) return false;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (d === 0) return false;
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  return h >= 8 && h <= 65 && s > 0.3 && l > 0.12 && l < 0.93;
}`;

test("theme tokens are a violet-to-blue system with no orange or amber", async ({ page }) => {
  await page.goto("/dashboard");
  const tokens = await page.evaluate((warmSource) => {
    const warm = new Function(`return ${warmSource}`)() as (rgb: string) => boolean;
    const style = getComputedStyle(document.documentElement);
    const names = ["violet", "indigo", "blue", "blue-deep", "iris", "iris-hot", "iris-soft", "iris-core", "iris-deep", "spectre", "amethyst", "ok", "warn", "bad", "bone", "ash"];
    return names.map((name) => {
      const triplet = style.getPropertyValue(`--${name}-rgb`).trim();
      return { name, triplet, warm: warm(`rgb(${triplet.split(/\s+/).join(", ")})`) };
    });
  }, WARM);
  for (const token of tokens) {
    expect(token.triplet, `--${token.name}-rgb is defined`).toMatch(/^\d+ \d+ \d+$/);
    expect(token.warm, `--${token.name}-rgb (${token.triplet}) must not be orange/amber`).toBe(false);
  }
  const byName = Object.fromEntries(tokens.map((t) => [t.name, t.triplet]));
  expect(byName.violet).toBe("124 58 237");
  expect(byName.blue).toBe("59 130 246");
});

test("no rendered element uses an orange or amber colour", async ({ page }) => {
  for (const route of ROUTES) {
    await page.goto(route);
    await expect(page.locator("h1").first()).toBeVisible();
    const offenders = await page.evaluate((warmSource) => {
      const warm = new Function(`return ${warmSource}`)() as (rgb: string) => boolean;
      const props = ["color", "backgroundColor", "borderTopColor", "borderBottomColor", "outlineColor", "fill", "stroke"] as const;
      const found: string[] = [];
      for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
        const style = getComputedStyle(el);
        for (const prop of props) {
          if (warm(style[prop])) found.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)} ${prop}=${style[prop]}`);
        }
        const images = `${style.backgroundImage} ${style.boxShadow}`;
        for (const match of images.match(/rgba?\([^)]*\)/g) ?? []) {
          if (warm(match)) found.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)} gradient/shadow=${match}`);
        }
      }
      return found.slice(0, 10);
    }, WARM);
    expect(offenders, `${route} has warm colours`).toEqual([]);
  }
});

test("a disabled action always says why", async ({ page }) => {
  await page.goto("/swap");
  const buy = page.getByRole("button", { name: "Buy xTOMB", exact: true });
  await expect(buy).toBeDisabled();
  await expect(page.getByLabel("Swap ticket").locator("[data-reason]")).toContainText("Not deployed on Local EVM");
  await page.goto("/masonry");
  await expect(page.getByRole("button", { name: "Stake in xROOM", exact: true })).toBeDisabled();
  await expect(page.locator("[data-reason]").first()).toContainText("Not deployed");
});

test("an unsupported wallet can switch to the configured chain and is never asked to send a transaction", async ({ page }) => {
  await page.addInitScript(() => {
    let chain = "0x1";
    const callbacks: Record<string, Array<(value: string) => void>> = {};
    const requests: string[] = [];
    Object.assign(window, {
      walletRequests: requests,
      ethereum: {
        isMetaMask: true,
        on(event: string, callback: (value: string) => void) {
          (callbacks[event] ||= []).push(callback);
        },
        removeListener(event: string, callback: (value: string) => void) {
          callbacks[event] = (callbacks[event] || []).filter((value) => value !== callback);
        },
        async request({ method, params }: { method: string; params: Array<{ chainId: string }> }) {
          requests.push(method);
          if (["eth_accounts", "eth_requestAccounts"].includes(method)) return ["0x00000000000000000000000000000000000000a1"];
          if (method === "eth_chainId") return chain;
          if (["wallet_requestPermissions", "wallet_getPermissions"].includes(method)) return [{ parentCapability: "eth_accounts" }];
          if (method === "wallet_switchEthereumChain") {
            chain = params[0].chainId;
            for (const callback of callbacks.chainChanged || []) callback(chain);
            return null;
          }
          if (method === "eth_sendTransaction") throw new Error("Transactions disabled in browser test");
          return null;
        },
      },
    });
  });
  await page.goto("/swap");
  await page.getByRole("button", { name: "Connect wallet", exact: true }).first().click();
  const note = page.getByTestId("network-note");
  await expect(note).toContainText("unsupported network");
  const buy = page.getByRole("button", { name: "Buy xTOMB", exact: true });
  await expect(buy).toBeDisabled();
  await expect(page.getByLabel("Swap ticket").locator("[data-reason]")).toContainText("Switch your wallet to Local EVM");

  await page.getByRole("combobox", { name: "Network" }).selectOption("31337");
  await expect(note).toContainText("Local EVM has no protocol deployment configured");
  await expect(buy).toBeDisabled();

  const sent = await page.evaluate(() => (window as unknown as { walletRequests: string[] }).walletRequests.filter((method) => method === "eth_sendTransaction"));
  expect(sent).toEqual([]);
});

test("transaction sessions reject account, network and disconnection changes", () => {
  const origin = { chainId: 777, address: "0x00aA" as const };
  expect(sameWalletSession(origin, { chainId: 777, address: "0x00aa" })).toBe(true);
  expect(sameWalletSession(origin, { ...origin, chainId: 888 })).toBe(false);
  expect(sameWalletSession(origin, { ...origin, address: "0x00bb" })).toBe(false);
  expect(sameWalletSession(origin, {})).toBe(false);
  expect(sameWalletSession(null, origin)).toBe(false);
});

test("reduced motion leaves content visible and still", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/dashboard");
  const tile = page.locator("[data-reveal]").first();
  await expect(tile).toBeVisible();
  expect(await tile.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
});
