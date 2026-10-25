// node --test: no network. A fake RPC answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { setup, simulate, changes, text, txHash, symbolOf, limiter, handle, pub } from "../api/sim.ts";

const ME = "0x" + "a".repeat(40), POOL = "0x" + "b".repeat(40), TOKEN = "0x" + "c".repeat(40);
const word = (n: bigint | string) => "0x" + (typeof n === "string" ? n.slice(2) : n.toString(16)).padStart(64, "0");
const TRANSFER = "0xddf252ad1be2c89b69c2b068" + "fc378daa952ba7f163c4a11628f55a4df523b3ef";
const log = (t: string, a: string, b: string, n: bigint) => ({ address: t, topics: [TRANSFER, word(a), word(b)], data: word(n) });

// sends 1 ETH to a pool, gets 500 TOKEN; a reverted inner call and a delegatecall's value don't count
const TRACE = { from: ME, to: POOL, value: "0xde0b6b3a7640000", type: "CALL", calls: [
  { from: POOL, to: TOKEN, type: "CALL", logs: [log(TOKEN, POOL, ME, 500n)] },
  { from: POOL, to: ME, type: "CALL", value: "0x5", error: "execution reverted" },
  { from: ME, to: POOL, type: "DELEGATECALL", value: "0x7" },
] };

test("changes: ETH out, token in, reverted and delegatecall skipped", () => {
  assert.deepEqual(changes(TRACE, ME), [["eth", -(10n ** 18n)], [TOKEN, 500n]]);
});

test("symbolOf: ABI string, bytes32, junk", () => {
  const abi = "0x" + word(32n).slice(2) + word(4n).slice(2) + Buffer.from("WETH").toString("hex").padEnd(64, "0");
  assert.equal(symbolOf(abi), "WETH");
  assert.equal(symbolOf("0x" + Buffer.from("MKR").toString("hex").padEnd(64, "0")), "MKR");
  assert.equal(symbolOf("0x" + word(32n).slice(2) + word(9n).slice(2) + Buffer.from("visit.me ").toString("hex").padEnd(64, "0")), "?");
  assert.equal(symbolOf("0x"), "?");
});

function fake() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const s = setup({ RPC_1: "http://rpc" }, privateKey);
  s.fetch = (async (_u: string, o: any) => {
    const { method, params } = JSON.parse(o.body);
    const result = method === "eth_blockNumber" ? "0x100" : method === "debug_traceCall" ? TRACE
      : params[0].data === "0x313ce567" ? word(6n) : "0x" + Buffer.from("TOK").toString("hex").padEnd(64, "0");
    return new Response(JSON.stringify({ result }));
  }) as any;
  return s;
}
const BODY = { chain: 1, from: ME, to: POOL, value: String(10n ** 18n), data: "0x12345678", nonce: "0".repeat(32) };

test("simulate: the answer and its signature", async () => {
  const s = fake(), a = await simulate(s, BODY);
  assert.equal(a.block, 256);
  assert.equal(a.ok, "ok");
  assert.equal(a.tx, createHash("sha256").update(`${ME}\n${POOL}\n${10n ** 18n}\n0x12345678`).digest("hex"));
  assert.deepEqual(a.changes, [{ token: "eth", symbol: "ETH", decimals: 18, amount: "-1000000000000000000", usd: "" },
    { token: TOKEN, symbol: "TOK", decimals: 6, amount: "500", usd: "" }]);
  const t = text(a.nonce, 1, txHash(ME, POOL, 10n ** 18n, "0x12345678"), a.block, a.ok, a.changes);
  assert.equal(t, `clear-sim v1\n${"0".repeat(32)}\n1\n${a.tx}\n256\nok\neth,ETH,18,-1000000000000000000,\n${TOKEN},TOK,6,500,`);
  assert.ok(verify("sha256", Buffer.from(t), { key: s.key, dsaEncoding: "ieee-p1363" }, Buffer.from(a.r + a.s, "hex")));
});

test("simulate: bad input", async () => {
  const s = fake();
  for (const [k, v] of [["chain", 5], ["from", "0x12"], ["value", "-1"], ["nonce", "x"], ["sig", "secp256k1"], ["block", 999]] as const)
    await assert.rejects(simulate(s, { ...BODY, [k]: v }), k);
});

test("limiter: per IP, then all", () => {
  const told: string[] = [], l = limiter(2, 100, 3, (x) => told.push(x));
  assert.equal(l("a"), null);
  assert.equal(l("a"), null);
  assert.match(l("a")!, /Too many/);
  assert.match(l("b")!, /Too busy/);
  assert.equal(told.length, 1);
});

test("GET: the public key", async () => {
  const s = fake(), r = await (await handle(s, new Request("http://x/"), "")).json();
  assert.deepEqual([r.x, r.y], [pub(s.key).x, pub(s.key).y]);
  assert.deepEqual(r.chains, [1]);
});

test("changes: WETH wrap counts only from the chain's WETH", () => {
  const W = "0x" + "d".repeat(40), dep = "0xe1fffcc4923d04b559f4d2" + "9a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c";
  const t = { from: ME, to: W, value: "0x64", type: "CALL", logs: [{ address: W, topics: [dep, word(ME)], data: word(100n) }] };
  assert.deepEqual(changes(t, ME, W), [["eth", -100n], [W, 100n]]);
  assert.deepEqual(changes(t, ME, TOKEN), [["eth", -100n]]);
});
