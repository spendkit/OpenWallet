// Manual Circle catch-up with a longer lookback than the 2 hours the server uses.
//
//   pnpm circle:reconcile -- 72          # look back 72 hours
//
// Uses the same environment as the server (DATABASE_URL, CIRCLE_*), so run it where those are set. Safe to repeat:
// the ledger key makes an already-credited transfer a no-op, so it only credits what the server missed. It does not
// start the server; the running server picks up the credited money on its next funding pass.
import { bootstrapApplication } from "../src/bootstrap.js";

const hours = Number(process.argv.slice(2).find((a) => a !== "--") ?? "");
if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 90) {
  console.error("usage: pnpm circle:reconcile -- <hours back, 1..2160>");
  process.exit(2);
}

const { params } = await bootstrapApplication(process.env);
try {
  if (!params.circleDeposits) throw new Error("Circle deposits are not enabled here (CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, CIRCLE_WALLET_SET_ID)");
  const r = await params.circleDeposits.reconcile(hours * 3_600_000);
  console.log(`looked back ${hours}h: ${r.checked} inbound transfer(s) listed, ${r.credited} newly credited`);
  for (const i of r.ignored) console.log(`  not credited: ${i.id} (${i.reason})`);
  if (r.checked >= 500) console.log("WARNING: 500 or more listed; Circle paging stops at 500, so older transfers may be missing. Run again with a shorter window.");
} finally {
  await params.pool.end();
}
