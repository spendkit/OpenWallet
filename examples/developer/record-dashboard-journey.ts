// Records a developer's first visit to the dashboard as a shareable video: the landing page, creating an account,
// verifying identity with test details, creating an agent, and collecting the keys (owner token, agent token, MCP and
// REST snippets) from the Developers page. Every step is the real web app against the running service (Miden sandbox).
// Then funding, budgets, playground payments, the request log, take-back, revoke, key rotation and log-in. Keys masked.
// Creates one sandbox account and agent; a $25 simulated deposit and a $5 payment (sandbox money only).
// Needs scripts/sandbox-up.sh running and ffmpeg for the .mp4.
// Run: node --import tsx examples/developer/record-dashboard-journey.ts  -> examples/developer/recordings/dashboard-journey.mp4
import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type Locator, type Page } from "playwright-core";
import { baseUrl, call, fail, say, sleep } from "./lib.ts";

const outDir = fileURLToPath(new URL("./recordings/", import.meta.url));
const W = 1280, H = 800;
const run = Date.now().toString().slice(-6);

// Runs in every page: hides all but the first few characters of any key, even after "Reveal".
const MASK_SCRIPT = `(() => {
  const re = /\\b(uk|ak|us|dk|mk)_([A-Za-z0-9]{4})[A-Za-z0-9_-]{6,}/g;
  const fix = (n) => { if (n.nodeType === 3) { const t = n.nodeValue; if (re.test(t)) { re.lastIndex = 0; n.nodeValue = t.replace(re, "$1_$2••••••••••••"); } re.lastIndex = 0; }
    else if (n.nodeType === 1 && n.tagName !== "SCRIPT") { const w = document.createTreeWalker(n, NodeFilter.SHOW_TEXT); let x; while ((x = w.nextNode())) fix(x); } };
  new MutationObserver((ms) => ms.forEach((m) => { if (m.type === "characterData") fix(m.target); else m.addedNodes.forEach(fix); }))
    .observe(document, { subtree: true, childList: true, characterData: true });
})();`;

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
      const st = document.createElement("style");
      st.textContent = "#msg{bottom:96px !important;z-index:2147483646 !important}"; // keep the app's toasts visible above the caption bar
      document.head.append(st);
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
  await loc.pressSequentially(text, { delay: 45 });
  await sleep(300);
}
async function scrollTo(page: Page, loc: Locator, ms = 1200) {
  await loc.evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" }));
  await sleep(ms);
}
async function card(page: Page, title: string, sub: string, ms: number) {
  await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;display:grid;place-items:center;background:#0f1115;color:#fff;font-family:-apple-system,system-ui,sans-serif">
  <div style="text-align:center;max-width:900px;padding:0 40px"><div style="width:56px;height:56px;border-radius:16px;background:#4f7cff;margin:0 auto 26px"></div>
  <h1 style="font-size:44px;margin:0 0 18px;letter-spacing:-.02em">${title}</h1><p style="font-size:21px;line-height:1.55;color:#b9c0d0;margin:0">${sub}</p></div>`);
  await sleep(ms);
}

// ---------- the recording ----------
if ((await call("GET", "/healthz")).status !== 200) fail(`${baseUrl} is not up: scripts/sandbox-up.sh`);

rmSync(outDir + "raw-dash", { recursive: true, force: true });
mkdirSync(outDir + "raw-dash", { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: W, height: H }, colorScheme: "light", recordVideo: { dir: outDir + "raw-dash", size: { width: W, height: H } } });
await ctx.addInitScript(MASK_SCRIPT);
await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseUrl });
const page = await ctx.newPage();
page.on("dialog", (d) => void d.accept());
page.on("pageerror", (e) => console.error("page error:", e.message));
page.on("response", (r) => { if (r.status() >= 400 && r.url().includes("/api/")) console.error("api", r.status(), r.request().method(), new URL(r.url()).pathname); });
let failed = false;

try {
  await card(page, "Agent Cards: the developer journey",
    "Everything a developer does in the dashboard, from sign-up to keys, a first payment and staying in control.<br><br>Recorded live against the sandbox. Keys are masked in this video.", 5500);

  // 1. landing
  await page.goto(baseUrl + "/");
  await caption(page, "1 · Landing page", "A developer lands on Agent Cards: virtual cards for AI agents, with budgets.", 3200);
  await page.mouse.wheel(0, 700); await sleep(1600);
  await page.mouse.wheel(0, -700); await sleep(1000);
  await caption(page, "1 · Landing page", "They click Get started.", 600);
  await click(page, page.getByRole("link", { name: "Get started" }).first());
  await page.waitForURL(/\/app/);
  await page.getByRole("button", { name: "Create account" }).last().waitFor();

  // 2. sign up
  await caption(page, "2 · Sign up", "Signing up takes an email address. No password: the dashboard issues a token.", 2200);
  await type(page, page.locator("#email"), `dev+${run}@example.com`);
  await click(page, page.locator("#signupForm button[type=submit]"));
  await page.getByRole("heading", { name: "Overview" }).waitFor({ timeout: 30_000 });
  await caption(page, "2 · Sign up", "Account created. They're in the dashboard, and the token is saved in this browser.", 3500);

  // 3. verify identity
  await caption(page, "3 · Verify", "Step 1 of 5 is identity verification with the card issuer. In the sandbox, one click uses test details.", 3200);
  await page.waitForTimeout(500);
  await click(page, page.locator("#quick"));
  await page.locator("#kycArea", { hasText: "Verifying your identity" }).or(page.locator(".vcard .bal")).first().waitFor({ timeout: 60_000 });
  await caption(page, "3 · Verify", "Miden checks the details and issues a card. This takes a few seconds.", 500);
  await page.locator(".vcard .bal").waitFor({ timeout: 180_000 });
  await sleep(800);
  await caption(page, "3 · Verify", "Verified. The card is issued, and the Agents and Developers pages unlock.", 3800);

  // 4. fund the card
  await click(page, page.locator('.side a[data-v="fund"]'));
  await page.getByRole("heading", { name: "Fund" }).waitFor();
  await caption(page, "4 · Fund", "Fund: the card has its own USDC deposit address. Send testnet USDC here and it lands on the card.", 3800);
  if (await page.locator("#simForm").count()) {
    await scrollTo(page, page.locator("#simForm"), 600);
    await caption(page, "4 · Fund", "In the sandbox there's a shortcut: simulate a $25 deposit.", 1200);
    await click(page, page.locator("#sim"));
    await caption(page, "4 · Fund", "The deposit arrives and is moved onto the card automatically.", 500);
    await page.locator("#depTables .badge", { hasText: "completed" }).first().waitFor({ timeout: 180_000 });
    await scrollTo(page, page.locator("#depTables"), 600);
    await caption(page, "4 · Fund", "Card topped up: $25.00, labelled as simulated in the ledger.", 3500);
  }

  // 5. create an agent (this is where the agent key comes from)
  await click(page, page.locator('.side a[data-v="agents"]'));
  await caption(page, "5 · Agent", "Each agent gets its own token and limits, which can't exceed the card's. They create research-bot: $20 a payment, $50 a day.", 2600);
  await type(page, page.locator("#aName"), "research-bot");
  await click(page, page.locator("#aCreate"));
  await page.locator("#reveal .secret").waitFor({ timeout: 60_000 });
  await scrollTo(page, page.locator("#reveal .secret"), 600);
  await caption(page, "5 · Agent", "The agent's key (ak_…) is shown once. They copy it now.", 1800);
  await click(page, page.locator("#reveal .secret button[data-copy]"));
  await sleep(1500);
  const agent = page.locator("#agentList .agent").first();
  await scrollTo(page, agent, 600);
  await caption(page, "5 · Agent", "An agent spends only what it's given. They give research-bot a $10 budget from the card.", 1500);
  await click(page, agent.locator(".give"));
  await agent.locator(".stat b", { hasText: "$10.00" }).first().waitFor({ timeout: 60_000 });
  await caption(page, "5 · Agent", "research-bot now holds $10.00. The rest stays on the card.", 3000);

  // 6. Developers page: the keys
  await click(page, page.locator('.side a[data-v="developers"]'));
  await page.getByRole("heading", { name: "Developers" }).waitFor();
  await caption(page, "6 · Keys", "The Developers page has everything needed to connect: base URL, MCP endpoint and the owner key.", 3500);
  await point(page, page.locator("#dTok"));
  await caption(page, "6 · Keys", "The owner key (uk_…) manages the account. Reveal shows it; Copy puts it on the clipboard.", 1500);
  await click(page, page.locator("#revTok"));
  await sleep(1500);
  await click(page, page.locator("#cpTok"));
  await sleep(1500);
  await click(page, page.locator("#revTok"));
  await caption(page, "6 · Keys", "Connection snippets come with the new agent's key filled in: Claude Code over MCP, plain REST, or MCP over stdio.", 1200);
  await scrollTo(page, page.locator("#connect"), 600);
  await point(page, page.locator("#connect .code").first());
  await sleep(2400);
  await point(page, page.locator("#connect .code").nth(1));
  await sleep(2000);
  await click(page, page.locator("#connect details.fold summary"));
  await sleep(2200);
  await click(page, page.locator("#connect .code .cp").first());
  await caption(page, "6 · Keys", "Copied. Paste that into Claude Code and the agent can pay, within its limits.", 3000);

  // 7. playground: call the agent API with the agent key
  await scrollTo(page, page.locator("#pgForm"), 800);
  await caption(page, "7 · Playground", "The playground calls the agent API exactly as an agent would. The new key is already in. First, the wallet.", 2400);
  await click(page, page.locator("#pgSend"));
  await page.locator("#pgRes .badge").waitFor({ timeout: 30_000 });
  await scrollTo(page, page.locator("#pgRes"), 600);
  await caption(page, "7 · Playground", "200: the key works, and the agent sees its $10 balance and limits.", 3500);
  await scrollTo(page, page.locator("#pgForm"), 600);
  await caption(page, "7 · Playground", "Now a real card payment: $5.00 to Example API, with an idempotency key.", 1200);
  await page.locator("#pgEp").selectOption("pay"); await sleep(1200);
  await click(page, page.locator("#pgSend"));
  await page.locator("#pgRes .badge").waitFor({ timeout: 90_000 });
  await page.waitForFunction(() => !document.querySelector("#pgSend")?.classList.contains("spin"), null, { timeout: 90_000 });
  await scrollTo(page, page.locator("#pgRes"), 600);
  await caption(page, "7 · Playground", "Approved by the card network. Every call shows the equivalent curl, too.", 3200);
  await click(page, page.locator("#pgRes details.fold summary"));
  await sleep(2200);
  await scrollTo(page, page.locator("#pgForm"), 600);
  await caption(page, "7 · Playground", "Limits hold: the agent tries $25.00, over its $20 per-payment limit.", 1000);
  await type(page, page.locator("#pgAmt"), "2500");
  await page.locator("#pgKey").fill(`demo-over-${run}`);
  await click(page, page.locator("#pgSend"));
  await page.waitForFunction(() => !document.querySelector("#pgSend")?.classList.contains("spin"), null, { timeout: 90_000 });
  await scrollTo(page, page.locator("#pgRes"), 600);
  await caption(page, "7 · Playground", "Refused, with the reason. Nothing is charged.", 3500);
  await scrollTo(page, page.locator("#pgForm"), 600);
  await caption(page, "7 · Playground", "And the agent's own history: GET /agent/v1/transactions.", 1000);
  await page.locator("#pgEp").selectOption("transactions"); await sleep(1000);
  await click(page, page.locator("#pgSend"));
  await page.waitForFunction(() => !document.querySelector("#pgSend")?.classList.contains("spin"), null, { timeout: 60_000 });
  await scrollTo(page, page.locator("#pgRes"), 600);
  await caption(page, "7 · Playground", "Both attempts, approved and declined, with amounts and reasons.", 3200);

  // 8. request log and overview
  await scrollTo(page, page.locator("#devLog"), 600);
  await page.locator("#devLog table").waitFor({ timeout: 30_000 }).catch(() => {});
  await caption(page, "8 · Activity", "The request log lists every agent payment, newest first, with its status and reason.", 3800);
  await click(page, page.locator('.side a[data-v="overview"]'));
  await caption(page, "8 · Activity", "Overview: the card balance, what's with agents, card limits, and recent payments.", 3200);
  await page.mouse.wheel(0, 500); await sleep(2200);
  await page.mouse.wheel(0, -500); await sleep(800);

  // 9. manage the agent: take money back, revoke
  await click(page, page.locator('.side a[data-v="agents"]'));
  const hide = page.locator("#hide");
  if (await hide.count()) await click(page, hide);
  await scrollTo(page, agent, 600);
  await caption(page, "9 · Control", "The agent shows its balance and what it spent today. The developer takes $3 back to the card.", 1200);
  await type(page, agent.locator(".amt"), "3");
  await click(page, agent.locator(".take"));
  await sleep(2500);
  await caption(page, "9 · Control", "And if an agent misbehaves, Revoke: its key stops working and its balance returns to the card.", 1400);
  await click(page, agent.locator(".revoke"));
  await page.locator("#revokedWrap:not([hidden])").waitFor({ timeout: 60_000 });
  await click(page, page.locator("#revokedWrap summary"));
  await sleep(2600);

  // 10. rotate the owner key, log out, log back in with it
  await click(page, page.locator('.side a[data-v="developers"]'));
  await caption(page, "10 · Account", "Leaked a key? Rotate it. The old owner key stops working immediately.", 1200);
  await click(page, page.locator("#rotTok"));
  await sleep(2500);
  const ownerKey = await page.evaluate(() => localStorage.getItem("agentCardsUserToken") ?? "");
  await caption(page, "10 · Account", "The owner key is the login, too. Log out, then sign back in with it.", 1000);
  await click(page, page.locator("#logout"));
  await sleep(1200);
  await click(page, page.getByRole("tab", { name: "I have a token" }));
  await page.locator("#tok").evaluate((el) => ((el as HTMLInputElement).type = "password"));
  await type(page, page.locator("#tok"), ownerKey);
  await click(page, page.locator("#loginForm button[type=submit]"));
  await page.locator("#logout").waitFor({ timeout: 30_000 });
  await click(page, page.locator('.side a[data-v="overview"]'));
  await page.getByRole("heading", { name: "Overview" }).waitFor({ timeout: 30_000 });
  await caption(page, "10 · Account", "Back in, with everything where they left it.", 2800);

  // 11. docs
  await click(page, page.locator(".side a.desk"));
  await page.waitForURL(/\/docs/);
  await paintCaption(page);
  await caption(page, "11 · Docs", "Full docs for the agent API, MCP tools, the developer API for onboarding your own users, and webhooks.", 3000);
  await page.mouse.wheel(0, 900); await sleep(2000);
  await page.mouse.wheel(0, 900); await sleep(2000);

  await card(page, "The developer journey",
    "Sign up · verify · fund · create an agent with limits and a budget · copy owner and agent keys with MCP and REST snippets · test payments in the playground · watch activity · take money back, revoke, rotate keys.<br><br>Docs: /docs", 7000);
} catch (e) {
  failed = true;
  await page.screenshot({ path: outDir + "dashboard-journey-failure.png" }).catch(() => {});
  console.error(e);
} finally {
  const video = page.video();
  await ctx.close();
  await browser.close();
  if (video && !failed) {
    const webm = outDir + "dashboard-journey.webm";
    renameSync(await video.path(), webm);
    try {
      execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", webm, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "22", "-movflags", "+faststart", outDir + "dashboard-journey.mp4"]);
      say(`video: ${outDir}dashboard-journey.mp4`);
    } catch {
      say(`video: ${webm} (ffmpeg not found, so no .mp4)`);
    }
  }
  rmSync(outDir + "raw-dash", { recursive: true, force: true });
  if (failed) process.exit(1);
}
