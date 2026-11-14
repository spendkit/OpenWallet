import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * SPEC for the stablecoin base-unit -> ledger cents conversion. Implemented in src/lib/utils/units.ts.
 *
 * Proposed rule:
 *  - Input is a bigint of base units (or a decimal string parsed without floats). Never a JS number:
 *    1e6-scaled values lose precision above 2^53 base units (~9 billion USDC) and 0.1+0.2 style errors creep in.
 *  - cents = floor(base / 10^(decimals-2)); dust = base mod 10^(decimals-2). For 6 decimals: divisor 10_000.
 *  - Decimals come from the (asset, chain) pair, not the symbol: USDT/USDC on BNB Chain are 18 decimals, on Ethereum 6.
 *  - base <= 0 is rejected. base > 0 but cents == 0 (sub-cent) is dust only: record it, post NO ledger tx
 *    (the ledger rejects zero postings), and never fund.
 *  - cents above Number.MAX_SAFE_INTEGER is rejected.
 *  - Dust is kept (in a dust log / external:<asset> remainder), never credited, never rounded up.
 */
type Convert = (base: bigint, decimals: number) => { cents: number; dustBase: bigint };

async function load(): Promise<Convert> {
  const mod = (await import("../src/lib/utils/units.js" as string)) as { baseUnitsToCents: Convert };
  return mod.baseUnitsToCents;
}

const cases: [string, bigint, number, number, bigint][] = [
  ["exactly 1 USDC", 1_000_000n, 6, 100, 0n],
  ["1 cent", 10_000n, 6, 1, 0n],
  ["just under 1 cent is dust only", 9_999n, 6, 0, 9_999n],
  ["1 base unit is dust only", 1n, 6, 0, 1n],
  ["999_999 rounds DOWN to 99c, dust 9_999", 999_999n, 6, 99, 9_999n],
  ["1.005 USDC -> 100c, dust 5_000 (not 101)", 1_005_000n, 6, 100, 5_000n],
  ["1.009999 USDC -> 100c, never 101", 1_009_999n, 6, 100, 9_999n],
  ["10_000.50 USDC", 10_000_500_000n, 6, 1_000_050, 0n],
  ["18-decimal asset (BNB Chain USDT): 1.00", 10n ** 18n, 18, 100, 0n],
];

for (const [name, base, dec, cents, dust] of cases) {
  test(`units: ${name}`, async () => {
    const convert = await load();
    assert.deepEqual(convert(base, dec), { cents, dustBase: dust });
  });
}

test("units: zero, negative are rejected", async () => {
  const convert = await load();
  assert.throws(() => convert(0n, 6));
  assert.throws(() => convert(-1_000_000n, 6));
});

test("units: result above MAX_SAFE_INTEGER cents is rejected", async () => {
  const convert = await load();
  assert.throws(() => convert(10n ** 30n, 6));
});

test("units: a JS number input is rejected (no float path)", async () => {
  const convert = await load();
  assert.throws(() => convert(1_000_000 as unknown as bigint, 6));
});

test("units: invalid decimals (< 2, fractional, NaN) are rejected", async () => {
  const convert = await load();
  assert.throws(() => convert(100n, 1));
  assert.throws(() => convert(100n, 6.5));
  assert.throws(() => convert(100n, NaN));
});

test("units: summing per-deposit rounding never credits more than was received", async () => {
  const convert = await load();
  let creditedBase = 0n;
  let received = 0n;
  for (let i = 0n; i < 500n; i++) {
    const base = 1_000_000n + i * 7_919n; // arbitrary non-round amounts
    received += base;
    creditedBase += BigInt(convert(base, 6).cents) * 10_000n;
  }
  assert.ok(creditedBase <= received);
});

test("units: round-trip conversion + dust equals the input", async () => {
  const convert = await load();
  for (const base of [1n, 9_999n, 10_000n, 123_456_789n, 999_999_999_999n]) {
    const { cents, dustBase } = convert(base, 6);
    assert.equal(BigInt(cents) * 10_000n + dustBase, base);
    assert.ok(dustBase >= 0n && dustBase < 10_000n);
  }
});
