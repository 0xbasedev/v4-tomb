// CDP overflow check: 390px viewport, all routes. Pure Node (built-in WebSocket).
const { spawn, execSync } = require("child_process");
const CHROME = process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell";
const PORT = 9222;
const ROUTES = ["/", "/genesis", "/farm", "/masonry", "/swap", "/bonds", "/docs", "/admin", "/wizard", "/bridge"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, "--headless", "--no-sandbox", "--disable-gpu", "about:blank"], { stdio: "ignore" });
  try {
    let targets;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); break; } catch {}
    }
    const page = targets.find((t) => t.type === "page");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    };
    const send = (method, params = {}) => new Promise((res) => {
      const mid = ++id; pending.set(mid, res);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    const results = [];
    for (const r of ROUTES) {
      await send("Page.navigate", { url: `http://localhost:3107${r}` });
      await sleep(2500);
      const ev = await send("Runtime.evaluate", {
        expression: `JSON.stringify({scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth, bodyScrollW: document.body.scrollWidth, overflowers: [...document.querySelectorAll('*')].filter(e => e.getBoundingClientRect().right > 391 || e.getBoundingClientRect().left < -1).slice(0,5).map(e => e.tagName + '.' + (e.className && e.className.baseVal === undefined ? String(e.className).split(' ')[0] : ''))})`,
        returnByValue: true,
      });
      const v = JSON.parse(ev.result.result.value);
      results.push({ route: r, ...v });
      console.log(r, "scrollWidth=" + v.scrollW, "innerWidth=" + v.innerW, "overflowers=" + JSON.stringify(v.overflowers));
    }
    const bad = results.filter((x) => x.scrollW > 390);
    console.log(bad.length === 0 ? "OVERFLOW CHECK: PASS — 0px horizontal overflow at 390px on all routes" : "OVERFLOW CHECK: FAIL — " + JSON.stringify(bad));
    ws.close();
  } finally {
    chrome.kill();
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
