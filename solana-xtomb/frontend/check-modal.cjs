// CDP smoke: open /swap, click "Review swap", check modal + Lottie mount, capture console errors.
const { spawn } = require("child_process");
const CHROME = process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell";
const PORT = 9223;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, "--headless", "--no-sandbox", "--disable-gpu", "about:blank"], { stdio: "ignore" });
  try {
    let targets;
    for (let i = 0; i < 30; i++) { await sleep(500); try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); break; } catch {} }
    const page = targets.find((t) => t.type === "page");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0; const pending = new Map(); const errors = [];
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === "Runtime.exceptionThrown") errors.push("EXCEPTION: " + JSON.stringify(m.params.exceptionDetails).slice(0, 300));
      if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push("CONSOLE ERROR: " + m.params.args.map((a) => a.value || a.description || "").join(" ").slice(0, 300));
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    };
    const send = (method, params = {}) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
    await send("Page.enable"); await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await send("Page.navigate", { url: "http://localhost:3107/swap" });
    await sleep(3000);
    const click = await send("Runtime.evaluate", { expression: `(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Review swap')); if(!b) return 'BUTTON NOT FOUND'; b.click(); return 'clicked'; })()`, returnByValue: true });
    console.log("click:", click.result.result.value);
    await sleep(2500);
    const check = await send("Runtime.evaluate", { expression: `JSON.stringify({modal: !!document.body.textContent.includes('Confirm swap'), lottieSvg: document.querySelectorAll('svg').length, bodyHasCheck: document.body.textContent.includes('dot → ring')})`, returnByValue: true });
    console.log("modal check:", check.result.result.value);
    console.log("console errors/exceptions:", errors.length ? errors : "none");
    ws.close();
  } finally { chrome.kill(); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
