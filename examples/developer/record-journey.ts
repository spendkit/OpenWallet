// Records the whole developer journey as a video you can share: a developer (Shopbot) onboards a user, the user verifies
// on the hosted /connect page and sets limits, an agent pays a real shop over MCP, a payment over the limit is declined,
// and the user pauses the agent. Every call is real (Miden sandbox); keys are masked on screen.
// MOVES SANDBOX MONEY (a $50 simulated deposit, about $21 spent). Needs the service running (pnpm dev:up) and ffmpeg for the .mp4.
// Run: node --import tsx examples/developer/record-journey.ts   -> examples/developer/recordings/agent-cards-journey.mp4
import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { chromium, type Locator, type Page } from "playwright-core";
import { AgentCardsCheckout } from "../../sdk/checkout/src/index.ts";
import { createShop } from "../shop/server.ts";
import { baseUrl, call, fail, ok, say, simulatedDeposit, sleep, until } from "./lib.ts";
import { verify } from "./webhook-verify.ts";

const outDir = fileURLToPath(new URL("./recordings/", import.meta.url));
const W = 1280, H = 800;
const run = Date.now().toString().slice(-6);

// ---------- what the viewer reads ----------
const mask = (s: string) => s.replace(/\b(dk|ak|us|uk|mk|whsec)_[A-Za-z0-9]+/g, "$1_••••••");
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
type Entry = { who: "server" | "agent" | "hook" | "note"; title: string; body?: string; tone?: "ok" | "bad" };
const entries: Entry[] = [];

const CONSOLE_HTML = `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box} body{margin:0;background:#0f1115;color:#e6e8ee;font:15px/1.45 -apple-system,system-ui,sans-serif}
header{padding:22px 32px 6px;font-weight:700;font-size:20px} header span{color:#8b93a7;font-weight:500;font-size:15px;margin-left:10px}
.cols{display:grid;grid-template-columns:1.35fr 1fr;gap:20px;padding:12px 32px 120px;height:100vh}
.col{background:#171a21;border:1px solid #262b36;border-radius:14px;padding:14px 16px;overflow:hidden;display:flex;flex-direction:column}
.col h2{margin:0 0 10px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#8b93a7}
.list{display:flex;flex-direction:column;gap:10px;justify-content:flex-end;flex:1;overflow:hidden}
.e{border:1px solid #262b36;border-radius:10px;padding:10px 12px;background:#1d212a}
.e b{display:block;font-size:14px;margin-bottom:4px} .e pre{margin:0;font:12.5px/1.45 ui-monospace,Menlo,monospace;color:#b9c0d0;white-space:pre-wrap;word-break:break-all}
.server b{color:#7cc4ff} .agent b{color:#ffcf6b} .hook b{color:#8be0a4} .note b{color:#c7a6ff}
.ok{border-color:#2f7d4a} .bad{border-color:#a3393f} .bad b{color:#ff8a8f}
</style><header>Behind the scenes<span>real API calls, keys hidden</span></header>
<div class="cols"><div class="col"><h2>Shopbot's server and its agent</h2><div class="list" id="L"></div></div>
<div class="col"><h2>Webhooks Shopbot receives</h2><div class="list" id="R"></div></div></div>`;

function entryHtml(e: Entry): string {
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  return `<div class="e ${e.who} ${e.tone ?? ""}"><b>${esc(mask(e.title))}</b>${e.body ? `<pre>${esc(mask(e.body))}</pre>` : ""}</div>`;
}

let onConsole = false;
async function showConsole(page: Page) {
  await page.setContent(CONSOLE_HTML);
  onConsole = true;
  for (const e of entries) await page.evaluate(([html, right]) => { document.getElementById(right ? "R" : "L")!.insertAdjacentHTML("beforeend", html); }, [entryHtml(e), e.who === "hook"] as const);
}
async function log(page: Page, e: Entry, pause = 1600) {
  entries.push(e);
  if (onConsole) {
    await page.evaluate(([html, right]) => {
      const list = document.getElementById(right ? "R" : "L")!;
      list.insertAdjacentHTML("beforeend", html);
      while (list.children.length > 1 && list.scrollHeight > list.clientHeight) list.firstElementChild!.remove();
    }, [entryHtml(e), e.who === "hook"] as const);
    await sleep(pause);
  }
}
const brief = (o: Record<string, unknown>, keys: string[]) => JSON.stringify(Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]])), null, 1).replace(/\n\s*/g, " ");

// ---------- caption bar and a visible cursor (headless video has no pointer) ----------
let captionText = "";
async function caption(page: Page, step: string, text: string, read = 2800) {
  captionText = `${step}|${text}`;
  await paintCaption(page);
  await sleep(read);
}
async function paintCaption(page: Page) {
  const [step, text] = captionText.split("|");
  await page.evaluate(([step, text]) => {
    let bar = document.getElementById("__cap");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "__cap";
      Object.assign(bar.style, { position: "fixed", left: "0", right: "0", bottom: "0", zIndex: "2147483647", background: "#111827", color: "#fff",
        padding: "16px 32px", font: "600 19px/1.4 -apple-system,system-ui,sans-serif", display: "flex", gap: "16px", alignItems: "center", borderTop: "3px solid #4f7cff" });
      bar.innerHTML = '<span id="__step" style="background:#4f7cff;border-radius:8px;padding:3px 10px;font-size:14px;white-space:nowrap"></span><span id="__txt"></span>';
      document.body.append(bar);
      document.body.style.paddingBottom = "90px";
      const dot = document.createElement("div");
      dot.id = "__cur";
      Object.assign(dot.style, { position: "fixed", left: "-40px", top: "-40px", width: "22px", height: "22px", borderRadius: "50%", background: "#ff4d6d",
        border: "3px solid #fff", zIndex: "2147483647", pointerEvents: "none", transition: "left .5s ease, top .5s ease, transform .15s" });
      document.body.append(dot);
    }
    document.getElementById("__step")!.textContent = step!;
    document.getElementById("__txt")!.textContent = text!;
  }, [step ?? "", text ?? ""] as const);
}
async function point(page: Page, loc: Locator) {
  await loc.scrollIntoViewIfNeeded();
  const b = await loc.boundingBox();
  if (!b) return;
  await page.evaluate(([x, y]) => { const d = document.getElementById("__cur"); if (d) { d.style.left = `${x - 11}px`; d.style.top = `${y - 11}px`; } }, [b.x + b.width / 2, b.y + b.height / 2]);
  await sleep(650);
}
async function click(page: Page, loc: Locator) {
  await point(page, loc);
  await page.evaluate(() => { const d = document.getElementById("__cur"); if (d) { d.style.transform = "scale(.7)"; setTimeout(() => (d.style.transform = ""), 180); } });
  await loc.click();
  await sleep(500);
}
async function type(page: Page, loc: Locator, text: string) {
  await point(page, loc);
  await loc.click();
  await loc.fill("");
  await loc.pressSequentially(text, { delay: 35 });
  await sleep(250);
}
async function goto(page: Page, url: string) {
  onConsole = false;
  await page.goto("about:blank"); // setContent keeps the old URL, so /connect#new-session would be a fragment-only (no-load) navigation
  await page.goto(url);
  await paintCaption(page);
}
async function card(page: Page, title: string, sub: string, ms: number) {
  onConsole = false;
  await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;display:grid;place-items:center;background:#0f1115;color:#fff;font-family:-apple-system,system-ui,sans-serif">
  <div style="text-align:center;max-width:900px;padding:0 40px"><div style="width:56px;height:56px;border-radius:16px;background:#4f7cff;margin:0 auto 26px"></div>
  <h1 style="font-size:44px;margin:0 0 18px;letter-spacing:-.02em">${title}</h1><p style="font-size:21px;line-height:1.55;color:#b9c0d0;margin:0">${sub}</p></div>`);
  await sleep(ms);
}

// ---------- the services around the recording: a webhook receiver and the sample shop ----------
async function startReceiver(page: () => Page): Promise<{ url: string; setSecret(s: string): void; close(): void }> {
  let secret = "";
  const seen = new Set<string>();
  const srv = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const good = verify(secret, req.headers["x-agentcards-signature"] as string | undefined, raw);
      res.writeHead(good ? 200 : 401).end();
      const id = String(req.headers["x-agentcards-event-id"]);
      if (!good || seen.has(id)) return;
      seen.add(id);
      const ev = JSON.parse(raw) as { type: string; data: Record<string, unknown> };
      const d = ev.data;
      const detail = ev.type === "spend.settled" ? `${d.status} ${usd(Number(d.amountCents))} at ${d.merchant}${d.reason ? ` (${d.reason})` : ""}`
        : ev.type === "kyc.updated" ? `KYC ${d.kycStatus}` : ev.type === "funding.completed" ? `card funded ${d.amountCents ? usd(Number(d.amountCents)) : ""}` : "the user's card is ready";
      void log(page(), { who: "hook", title: ev.type, body: `${detail}\nsignature verified ✓`, tone: ev.type === "spend.settled" && d.status !== "approved" ? "bad" : "ok" }, 0);
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { url: `http://localhost:${(srv.address() as AddressInfo).port}/hooks`, setSecret: (s) => (secret = s), close: () => srv.close() };
}

async function startShop(): Promise<{ url: string; close(): void }> {
  const { secretKey } = await AgentCardsCheckout.signup({ baseUrl }, { name: "Bean & Brew", email: `shop+${run}@example.com`, mcc: "5499" });
  const srv = createShop({ checkout: new AgentCardsCheckout({ baseUrl, secretKey }), log: () => {} });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => srv.close() };
}

async function idPhoto(browser: import("playwright-core").Browser, path: string) {
  const p = await browser.newPage({ viewport: { width: 640, height: 400 } });
  await p.setContent(`<body style="margin:0;background:#e9eef5;display:grid;place-items:center;height:100vh;font-family:system-ui">
  <div style="width:560px;height:340px;border-radius:22px;background:#fff;border:2px solid #9aa9c0;padding:26px;display:grid;grid-template-columns:150px 1fr;gap:24px">
  <div style="background:#c9d3e3;border-radius:12px"></div><div><div style="font:700 15px system-ui;color:#55657f;letter-spacing:.1em">SAMPLE PASSPORT · NOT REAL</div>
  <div style="font:700 30px system-ui;margin:18px 0 6px">ADA OKAFOR</div><div style="color:#55657f">Sandbox test document</div></div></div>`);
  await p.screenshot({ path });
  await p.close();
}

// ---------- the recording ----------
const health = await call("GET", "/healthz");
if (health.status !== 200) fail(`${baseUrl} is not up: pnpm dev:up`);
if ((await call("GET", "/developer/v1/me")).status === 404) fail("this server has no developer API. Restart it on current code: pnpm dev:down && pnpm dev:up");

rmSync(outDir + "raw", { recursive: true, force: true });
mkdirSync(outDir + "raw", { recursive: true });
const browser = await chromium.launch();
const photo = outDir + "raw/id.png";
await idPhoto(browser, photo);
const ctx = await browser.newContext({ viewport: { width: W, height: H }, colorScheme: "light", recordVideo: { dir: outDir + "raw", size: { width: W, height: H } } });
const page = await ctx.newPage();
const receiver = await startReceiver(() => page);
const shop = await startShop();
let mcp: Client | undefined;

try {
  // 1. title
  await card(page, "Agent Cards: the developer journey",
    "Shopbot builds a shopping assistant. Its users each get a card, and Shopbot's AI agent spends from it, inside limits the user controls.<br><br>Recorded live in the sandbox. Test money only.", 6000);

  // 2. developer onboarding
  await showConsole(page);
  await caption(page, "1 · Developer", "Shopbot signs up once and tells us where to send events.", 1200);
  const dev = await ok("signup", call("POST", "/developer/v1/signup", undefined, { name: "Shopbot", email: `dev+${run}@shopbot.example` }), 201);
  await log(page, { who: "server", title: "POST /developer/v1/signup", body: `{"name":"Shopbot"}\n→ developerId ${dev.developerId}, key dk_ (shown once)` });
  const settings = await ok("settings", call("POST", "/developer/v1/settings", dev.key, { webhookUrl: receiver.url }));
  receiver.setSecret(settings.webhookSecret);
  await log(page, { who: "server", title: "POST /developer/v1/settings", body: `{"webhookUrl":"https://shopbot…/hooks"}\n→ signing secret whsec_ (shown once)` });

  await caption(page, "2 · New customer", "A customer, Ada, turns on payments in Shopbot. Shopbot creates her user and a one-hour link.", 1200);
  const externalId = `ada-${run}`;
  const user = await ok("user", call("POST", "/developer/v1/users", dev.key, { externalId, email: `ada+${run}@example.com` }), 201);
  await log(page, { who: "server", title: "POST /developer/v1/users", body: `{"externalId":"${externalId}"}\n→ ${brief(user, ["userId", "kycStatus", "privacyMode"])}` });
  const sess = await ok("session", call("POST", `/developer/v1/users/${user.userId}/sessions`, dev.key, { ttlSeconds: 3600 }), 201);
  await log(page, { who: "server", title: `POST /developer/v1/users/${user.userId}/sessions`, body: `→ url …/connect#session=us_  (expires in 1h; Shopbot never sees her ID)` }, 2200);

  // 3. hosted KYC
  await goto(page, sess.url);
  await page.getByRole("heading", { name: "Verify your identity" }).waitFor();
  await caption(page, "3 · Hosted page", "Ada opens the link. This page is hosted by Agent Cards: her identity goes straight to the card issuer.", 3500);
  const dob = `1990-0${1 + (Number(run) % 9)}-1${Number(run) % 9}`;
  await type(page, page.getByLabel("First name"), "Ada");
  await type(page, page.getByLabel("Last name"), "Okafor");
  await page.getByLabel("Date of birth").fill(dob);
  await type(page, page.getByLabel("Phone"), `+234803${run}0`);
  await type(page, page.getByLabel("Email"), `ada+${run}@example.com`);
  await click(page, page.getByRole("button", { name: "Continue" }));
  await type(page, page.getByLabel("Street address"), "12 Admiralty Way");
  await type(page, page.getByLabel("City"), "Lagos");
  await type(page, page.getByLabel("State or region"), "Lagos");
  await type(page, page.getByLabel("Postcode"), "101233");
  await type(page, page.getByLabel("Country"), "NG");
  await click(page, page.getByRole("button", { name: "Continue" }));
  await caption(page, "3 · Hosted page", "She adds her ID. (A sample document: this is the sandbox.)", 1500);
  await type(page, page.getByLabel("ID number"), `A${run}77`);
  await page.getByLabel("Photo of the front of your ID").setInputFiles(photo);
  await sleep(1200);
  await click(page, page.getByRole("button", { name: "Continue" }));
  await caption(page, "3 · Hosted page", "She checks her details and submits.", 2200);
  await click(page, page.getByRole("button", { name: "Submit for verification" }));
  await sleep(3000);

  // 4. waiting for the card, shown through the webhooks
  await showConsole(page);
  await caption(page, "4 · Verification", "The issuer checks her ID and issues her card. Shopbot hears about it by signed webhook.", 1000);
  await until("the card", async () => (await call("POST", "/api/me/refresh", sess.token)).data, (d: any) => d.card?.deposit?.address, 180_000);
  await sleep(6000);

  // 5. money in, agent created
  await caption(page, "5 · Funding", "Ada tops up with $50 of USDC to her deposit address. (Simulated deposit: sandbox.)", 1000);
  await log(page, { who: "note", title: "Ada sends $50.00 USDC to her deposit address", body: "the deposit is credited and moved onto her card" });
  await simulatedDeposit(sess.token, 5_000);
  await sleep(4000);
  await caption(page, "6 · Agent", "Shopbot creates an agent for Ada with limits, and gives it $40 of her balance.", 1000);
  const agent = await ok("agent", call("POST", `/developer/v1/users/${user.userId}/agents`, dev.key, { name: "Shopbot assistant", perTransactionCents: 3_000, dailyCents: 6_000 }), 201);
  await log(page, { who: "server", title: `POST …/users/${user.userId}/agents`, body: `{"name":"Shopbot assistant","perTransactionCents":3000,"dailyCents":6000}\n→ agentId ${agent.agentId}, token ak_ (handed to the agent)` });
  await ok("fund", call("POST", `/developer/v1/users/${user.userId}/agents/${agent.agentId}/fund`, dev.key, { amountCents: 4_000 }));
  await log(page, { who: "server", title: `POST …/agents/${agent.agentId}/fund`, body: `{"amountCents":4000}  → the agent now holds $40.00` }, 2500);

  // 6. the user tightens the limit
  const sess2 = await ok("session", call("POST", `/developer/v1/users/${user.userId}/sessions`, dev.key, { ttlSeconds: 3600 }), 201);
  await goto(page, sess2.url);
  await page.getByRole("heading", { name: "Spend controls" }).waitFor();
  await caption(page, "7 · Spend controls", "Back on the hosted page, Ada sees her card and the new agent.", 3500);
  await caption(page, "7 · Spend controls", "She thinks $30 a purchase is too much, and lowers it to $25.", 800);
  await click(page, page.getByText("Limits", { exact: true }));
  await type(page, page.getByLabel("Per-payment limit"), "25");
  await click(page, page.getByRole("button", { name: "Save limits" }));
  await sleep(2500);

  // 7. the agent shops
  await goto(page, shop.url);
  await caption(page, "8 · Shopping", "Ada asks the assistant for coffee beans and filters from Bean & Brew, an ordinary online shop.", 2500);
  await click(page, page.locator('[data-add="beans"]'));
  await click(page, page.locator('[data-add="filters"]'));
  await click(page, page.locator("#go"));
  await page.getByRole("heading", { name: "Pay for your order" }).waitFor();
  await caption(page, "8 · Shopping", "The shop makes a $21.00 checkout. The agent gets this link: never Ada's card number.", 3500);
  const orderUrl = page.url();
  const checkoutId = /cs_[a-f0-9]{32}/.exec(await page.locator("#link").innerText())![0];

  mcp = new Client({ name: "shopbot-assistant", version: "1.0.0" });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${agent.token}` } } }));
  const tool = async (name: string, args: Record<string, unknown>) => {
    let r: any;
    try { r = await mcp!.callTool({ name, arguments: args }); } catch (e) { // a revoked token is refused before MCP runs: HTTP 401
      return { error: true, data: {}, text: String((e as Error).message).replace(/^.*?(\{.*\})$/, "$1") };
    }
    const text = r.content?.[0]?.text ?? "";
    try { return { error: !!r.isError, data: JSON.parse(text), text }; } catch { return { error: !!r.isError, data: {}, text }; }
  };
  await showConsole(page);
  await caption(page, "9 · Agent pays", "The agent uses its Agent Cards tools over MCP: it checks the price, then pays.", 800);
  const seen = await tool("get_checkout", { checkout_id: checkoutId });
  await log(page, { who: "agent", title: "MCP get_checkout", body: `${brief(seen.data, ["merchant", "description", "amountCents", "status"])}` });
  const paid = await tool("pay_checkout", { checkout_id: checkoutId, max_amount_usd: 21 });
  await log(page, { who: "agent", title: "MCP pay_checkout  (max $21.00)", body: brief(paid.data.payment ?? paid.data, ["status", "amountCents", "reason"]), tone: "ok" }, 4000);

  await goto(page, orderUrl);
  await page.getByText(/Paid\./).waitFor({ timeout: 60_000 });
  await caption(page, "9 · Agent pays", "The shop sees the payment. Order placed, without Ada typing a card number anywhere.", 4000);

  // 8. over the limit
  await goto(page, shop.url);
  await caption(page, "10 · Limits hold", "Later the agent is tempted by a $59 kettle.", 1200);
  await click(page, page.locator('[data-add="kettle"]'));
  await click(page, page.locator("#go"));
  await page.getByRole("heading", { name: "Pay for your order" }).waitFor();
  const kettleUrl = page.url();
  const kettleId = /cs_[a-f0-9]{32}/.exec(await page.locator("#link").innerText())![0];
  await showConsole(page);
  await caption(page, "10 · Limits hold", "It tries to pay. Ada's $25 limit says no, and nothing is charged.", 800);
  const refused = await tool("pay_checkout", { checkout_id: kettleId, max_amount_usd: 59 });
  await log(page, { who: "agent", title: "MCP pay_checkout  (max $59.00)", body: brief(refused.data.payment ?? refused.data, ["status", "amountCents", "reason"]) || refused.text, tone: "bad" }, 4500);
  await goto(page, kettleUrl);
  await page.getByText(/declined/).waitFor({ timeout: 30_000 }).catch(() => {});
  await caption(page, "10 · Limits hold", "The shop shows the attempt was declined. The order stays open; Ada decides.", 3500);

  // 9. pause
  const sess3 = await ok("session", call("POST", `/developer/v1/users/${user.userId}/sessions`, dev.key, { ttlSeconds: 3600 }), 201);
  await goto(page, sess3.url);
  await page.getByRole("heading", { name: "Spend controls" }).waitFor();
  await caption(page, "11 · Ada is in charge", "Ada sees what the agent spent today, and can pause it at any time.", 3500);
  await click(page, page.getByRole("button", { name: "Pause agent…" }));
  await click(page, page.getByRole("button", { name: "Yes, pause it" }));
  await sleep(2500);
  await showConsole(page);
  await caption(page, "11 · Ada is in charge", "The paused agent's next call is refused.", 800);
  const after = await tool("get_wallet", {});
  await log(page, { who: "agent", title: "MCP get_wallet", body: after.error ? `refused: ${after.text}` : after.text, tone: after.error ? "bad" : undefined }, 4000);

  // 10. end
  await card(page, "That's the flow",
    "Developer API for users, agents and limits · hosted /connect page for KYC and spend controls · agents pay over MCP · signed webhooks.<br><br>" +
    "Also available: <b>privacy mode</b>, where every purchase uses a fresh one-time card.<br>Docs: /docs#developer-demos", 7000);
} finally {
  await mcp?.close().catch(() => {});
  const video = page.video();
  await ctx.close();
  await browser.close();
  receiver.close();
  shop.close();
  if (video) {
    const webm = outDir + "agent-cards-journey.webm";
    renameSync(await video.path(), webm);
    try {
      execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", webm, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "22", "-movflags", "+faststart", outDir + "agent-cards-journey.mp4"]);
      say(`video: ${outDir}agent-cards-journey.mp4`);
    } catch {
      say(`video: ${webm} (ffmpeg not found, so no .mp4)`);
    }
  }
  rmSync(outDir + "raw", { recursive: true, force: true });
}
