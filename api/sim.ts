// clear-sim: what a transaction would move in and out of its sender, signed with P-256, for a hardware wallet that
// doesn't trust the computer it's plugged into. The whole server is this file. Format: SPEC.md. No dependencies.
// Runs as a Vercel function (this file) or a plain Node server (server.ts).
import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";

// Alchemy's name for each chain (ALCHEMY_API_KEY gives all of these; RPC_<chain> adds or overrides one)
export const ALCHEMY: Record<number, string> = { 1: "eth-mainnet", 8453: "base-mainnet", 10: "opt-mainnet", 42161: "arb-mainnet",
  137: "polygon-mainnet", 43114: "avax-mainnet", 56: "bnb-mainnet", 100: "gnosis-mainnet", 42220: "celo-mainnet",
  146: "sonic-mainnet", 84532: "base-sepolia", 11155111: "eth-sepolia" };
// each chain's own coin (ETH if not here)
export const COIN: Record<number, string> = { 137: "POL", 43114: "AVAX", 56: "BNB", 100: "XDAI", 42220: "CELO", 146: "S" };
// DexScreener's name for each chain: prices Alchemy doesn't have
const DEX: Record<number, string> = { 1: "ethereum", 8453: "base", 10: "optimism", 42161: "arbitrum", 137: "polygon",
  43114: "avalanche", 56: "bsc", 100: "gnosischain", 42220: "celo", 146: "sonic" };
const TEST = new Set([84532, 11155111]);   // test coins are worth nothing
// ERC-20 Transfer(address,address,uint256), in two parts so secret scanners don't take it for a key
const TRANSFER = "0xddf252ad1be2c89b69c2b068" + "fc378daa952ba7f163c4a11628f55a4df523b3ef";
// WETH's Deposit(address,uint256) and Withdrawal(address,uint256): wrapping moves WETH without a Transfer. Counted
// only from each chain's own WETH (other contracts use the same event names for other things).
const DEPOSIT = "0xe1fffcc4923d04b559f4d2" + "9a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c";
const WITHDRAWAL = "0x7fcf532c15f0a6db0bd6d0" + "e038bea71d30d808c7d98cb3bf7268a95bf5081b65";
const OP_WETH = "0x4200000000000000000000000000000000000006";
export const WETH: Record<number, string> = { 1: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", 8453: OP_WETH, 10: OP_WETH,
  42161: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1", 84532: OP_WETH, 11155111: "0xfff9976782d46cc05630d1f6ebab18b2324d6b14" };
export const MAX_DATA = 200_000;           // hex chars of calldata (a big 1inch swap is ~70,000)

export type Setup = {
  key: KeyObject;                          // P-256 private key
  rpc: Record<number, string>;             // chain -> RPC URL (must allow debug_traceCall)
  alchemy: string;                         // Alchemy key, for prices ("" = DexScreener only)
  limit: (ip: string) => string | null;    // null = go ahead, else why not
  fetch: typeof fetch;
};

export class Bad extends Error {
  status: number;
  constructor(msg: string, status = 400) { super(msg); this.status = status; }
}

/** The setup from env: SIM_KEY (base64 PKCS#8 DER), ALCHEMY_API_KEY, RPC_<chain>, PER_MIN, PER_DAY, ALL_DAY. */
export function setup(env: Record<string, string | undefined>, key?: KeyObject): Setup {
  const k = key || (env.SIM_KEY ? createPrivateKey({ key: Buffer.from(env.SIM_KEY, "base64"), format: "der", type: "pkcs8" }) : null);
  if (!k) throw new Error("no key: set SIM_KEY");
  const alchemy = env.ALCHEMY_API_KEY || "", rpc: Record<number, string> = {};
  if (alchemy) for (const [c, h] of Object.entries(ALCHEMY)) rpc[+c] = `https://${h}.g.alchemy.com/v2/${alchemy}`;
  for (const [n, v] of Object.entries(env)) { const m = n.match(/^RPC_(\d+)$/); if (m && v) rpc[+m[1]] = v; }
  const tell = env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID ? telegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID) : () => {};
  return { key: k, rpc, alchemy, fetch,
    limit: limiter(Number(env.PER_MIN) || 60, Number(env.PER_DAY) || 2000, Number(env.ALL_DAY) || 20_000, tell) };
}

/** The public key, as a wallet pins it: x and y, 64 hex each. */
export function pub(key: KeyObject) {
  const j = createPublicKey(key).export({ format: "jwk" }) as { x: string; y: string };
  const h = (b: string) => Buffer.from(b, "base64url").toString("hex").padStart(64, "0");
  return { x: h(j.x), y: h(j.y) };
}

/** Per IP: perMin a minute, perDay a day. All IPs: allDay a day, then none till tomorrow (UTC). Kept in memory, so on
 *  a host with many instances (Vercel) each instance counts on its own. */
export function limiter(perMin: number, perDay: number, allDay: number, tell: (s: string) => void) {
  let min = "", day = "", all = 0;
  const m = new Map<string, number>(), d = new Map<string, number>();
  return (ip: string) => {
    const t = new Date().toISOString();
    if (t.slice(0, 16) !== min) { min = t.slice(0, 16); m.clear(); }
    if (t.slice(0, 10) !== day) { day = t.slice(0, 10); d.clear(); all = 0; }
    if (++all === allDay + 1) tell(`${allDay} today, the cap. Off till tomorrow (UTC).`);
    if (all > allDay) return "Too busy today. Try tomorrow.";
    const a = (m.get(ip) || 0) + 1, b = (d.get(ip) || 0) + 1;
    m.set(ip, a); d.set(ip, b);
    return a > perMin || b > perDay ? "Too many. Wait a minute." : null;
  };
}

/** A Telegram note, at most one an hour. Never throws. */
function telegram(bot: string, chat: string) {
  let at = 0;
  return (text: string) => {
    if (Date.now() - at < 3_600_000) return;
    at = Date.now();
    fetch(`https://api.telegram.org/bot${bot}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: "⚠️ clear-sim: " + text }) }).catch(() => {});
  };
}

const hex = (x: unknown, n?: number) => typeof x === "string" && (n ? new RegExp(`^0x[0-9a-f]{${n}}$`) : /^0x([0-9a-f]{2})*$/).test(x);

async function rpc(s: Setup, url: string, method: string, params: unknown[]) {
  const r: any = await s.fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((x) => x.json());
  if (r?.error) throw new Error(r.error.message || "rpc");
  return r.result;
}

/** The sender's net change per token ("eth" for the coin), from a callTracer trace. Reverted frames don't count. */
export function changes(trace: any, who: string, weth = "") {
  const out = new Map<string, bigint>();
  const add = (t: string, n: bigint) => out.set(t, (out.get(t) || 0n) + n);
  const walk = (c: any) => {
    if (!c || c.error) return;
    const v = BigInt(c.value || "0x0"), from = String(c.from).toLowerCase(), to = String(c.to).toLowerCase();
    if (v && c.type !== "DELEGATECALL") { if (from === who) add("eth", -v); if (to === who) add("eth", v); }
    for (const l of c.logs || []) {
      const t = String(l.address).toLowerCase();
      if (t === weth && l.topics?.length === 2 && hex(l.data, 64) && "0x" + l.topics[1].slice(26) === who) {
        if (l.topics[0] === DEPOSIT) add(t, BigInt(l.data));
        if (l.topics[0] === WITHDRAWAL) add(t, -BigInt(l.data));
        continue;
      }
      if (l.topics?.length !== 3 || l.topics[0] !== TRANSFER || !hex(l.data, 64)) continue;   // ERC-20 only (721 has 4 topics)
      const a = "0x" + l.topics[1].slice(26), b = "0x" + l.topics[2].slice(26), n = BigInt(l.data);
      if (a === who) add(t, -n);
      if (b === who) add(t, n);
    }
    for (const s of c.calls || []) walk(s);
  };
  walk(trace);
  return [...out].filter(([, n]) => n !== 0n);
}

const META = new Map<string, { symbol: string; decimals: number }>();

/** A token's symbol and decimals, from the token itself (any node): "?" and -1 if it won't say. */
async function meta(s: Setup, chain: number, t: string) {
  const k = chain + ":" + t;
  if (!META.has(k)) {
    const call = (data: string) => rpc(s, s.rpc[chain], "eth_call", [{ to: t, data }, "latest"]).catch(() => "0x");
    const [sym, dec] = await Promise.all([call("0x95d89b41"), call("0x313ce567")]);   // symbol(), decimals()
    const symbol = symbolOf(sym), d = hex(dec, 64) ? Number(BigInt(dec)) : -1;
    if (META.size > 5000) META.clear();
    META.set(k, { symbol, decimals: d >= 0 && d <= 36 ? d : -1 });
  }
  return META.get(k)!;
}

/** symbol() as an ABI string, or as bytes32 (old tokens like MKR). Only short plain names; anything else is "?". */
export function symbolOf(r: unknown) {
  let s = "";
  if (typeof r === "string" && /^0x[0-9a-f]*$/i.test(r)) {
    const b = Buffer.from(r.slice(2), "hex");
    if (b.length >= 64) { const n = Number(b.readBigUInt64BE(56)); s = b.subarray(64, 64 + Math.min(n, 64)).toString("latin1"); }
    else if (b.length === 32) s = b.toString("latin1").replace(/\0+$/, "");
  }
  return /^[A-Za-z0-9.$_-]{1,12}$/.test(s) ? s : "?";
}

/** Dollar prices: the chain's coin and tokens (Alchemy, then DexScreener for the rest). Missing = no price. */
async function prices(s: Setup, chain: number, tokens: string[]) {
  const out: { eth: number | null; tokens: Record<string, number> } = { eth: null, tokens: {} };
  if (TEST.has(chain)) return out;
  const num = (p: any) => { const v = Number(p?.prices?.find((x: any) => x.currency === "usd")?.value); return v > 0 ? v : null; };
  const get = (u: string, o?: RequestInit) => s.fetch(u, o).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (s.alchemy && ALCHEMY[chain]) {
    const base = `https://api.g.alchemy.com/prices/v1/${s.alchemy}/tokens`;
    const [e, t]: any[] = await Promise.all([get(`${base}/by-symbol?symbols=${COIN[chain] || "ETH"}`),
      tokens.length ? get(`${base}/by-address`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ addresses: tokens.map((address) => ({ network: ALCHEMY[chain], address })) }) }) : null]);
    out.eth = num(e?.data?.[0]);
    for (const p of t?.data || []) { const v = num(p); if (v && p.address) out.tokens[String(p.address).toLowerCase()] = v; }
  }
  const ask = tokens.filter((a) => !out.tokens[a]).slice(0, 30);
  if (DEX[chain] && ask.length) {
    const pairs = await get(`https://api.dexscreener.com/tokens/v1/${DEX[chain]}/${ask.join(",")}`);
    for (const a of ask) {   // each token's most liquid pair
      const best = (Array.isArray(pairs) ? pairs : []).filter((p: any) => String(p?.baseToken?.address).toLowerCase() === a)
        .sort((x: any, y: any) => (y?.liquidity?.usd ?? 0) - (x?.liquidity?.usd ?? 0))[0];
      const v = Number(best?.priceUsd);
      if (v > 0) out.tokens[a] = v;
    }
  }
  return out;
}

/** Dollars for n raw units at price p per whole token, 2 decimals; "" with no price. */
const usd = (n: bigint, d: number, p: number | null | undefined) => (p && d >= 0 ? (Number(n) / 10 ** d * p).toFixed(2) : "");

export type Change = { token: string; symbol: string; decimals: number; amount: string; usd: string };

/** What gets signed (sha256, then P-256). */
export function text(nonce: string, chain: number, tx: string, block: number, ok: string, list: Change[]) {
  return ["clear-sim v1", nonce, chain, tx, block, ok, ...list.map((c) => [c.token, c.symbol, c.decimals, c.amount, c.usd].join(","))].join("\n");
}

/** sha256 hex of "<from>\n<to>\n<value>\n<data>" (and "\n1" for a delegatecall): the wallet works it out from what
 *  it's asked to sign. */
export const txHash = (from: string, to: string, value: bigint, data: string, operation = 0) =>
  createHash("sha256").update(`${from}\n${to}\n${value}\n${data}${operation ? "\n1" : ""}`).digest("hex");

const word = (h: string) => h.replace(/^0x/, "").padStart(64, "0");
/**
 * A delegatecall from a Safe (a MultiSend batch, operation 1), run the way it really runs: the Safe's own
 * execTransaction, called by one of its owners with an approved-by-caller signature (v = 1), the threshold set to 1
 * for this run only (storage slot 4). So every call in the batch comes from the Safe, and the Safe can take ETH back.
 * Not a Safe (no owners): Bad.
 */
async function safeRun(s: Setup, url: string, at: string, safe: string, to: string, value: bigint, data: string) {
  const owners: string = await rpc(s, url, "eth_call", [{ to: safe, data: "0xa0e67e2b" }, at]).catch(() => "0x");   // getOwners()
  if (!hex(owners) || owners.length < 2 + 64 * 3) throw new Bad("operation 1: from must be a Safe");
  const owner = "0x" + owners.slice(2 + 64 * 2 + 24, 2 + 64 * 3);
  const d = data.slice(2), pad = (h: string) => h + "0".repeat((64 - (h.length % 64)) % 64);
  const sig = word(owner) + word("0") + "01";                                    // r = the owner, s = 0, v = 1
  const dataAt = 10 * 32, sigAt = dataAt + 32 + pad(d).length / 2;
  const call = "0x6a761202" + word(to) + word(value.toString(16)) + word(dataAt.toString(16)) + word("1") + word("0") + word("0") + word("0")
    + word("0") + word("0") + word(sigAt.toString(16)) + word((d.length / 2).toString(16)) + pad(d) + word("41") + pad(sig);
  return [{ from: owner, to: safe, value: "0x0", data: call }, at,
    { tracer: "callTracer", tracerConfig: { withLog: true }, stateOverrides: { [safe]: { stateDiff: { ["0x" + word("4")]: "0x" + word("1") } } } }];
}

/** Run one request body. Throws Bad. */
export async function simulate(s: Setup, b: any) {
  const chain = Number(b?.chain), url = s.rpc[chain];
  const from = String(b?.from || "").toLowerCase(), to = String(b?.to || "").toLowerCase(), data = String(b?.data || "0x").toLowerCase();
  if (!url) throw new Bad("No such chain.", 404);
  if (!hex(from, 40) || !hex(to, 40) || !hex(data) || data.length > MAX_DATA) throw new Bad("from, to, data: hex");
  if (!/^\d{1,78}$/.test(String(b?.value ?? ""))) throw new Bad("value: a decimal string");
  if (!/^[0-9a-f]{32}$/.test(b?.nonce || "")) throw new Bad("nonce: 32 lowercase hex");
  if ((b.sig ?? "p256") !== "p256") throw new Bad("sig: only p256 for now");
  if (b.block !== undefined && !/^\d{1,12}$/.test(String(b.block))) throw new Bad("block: a decimal number");
  if (![undefined, 0, 1].includes(b.operation)) throw new Bad("operation: 0 (call) or 1 (delegatecall)");
  const op = b.operation === 1 ? 1 : 0;
  const value = BigInt(b.value);
  let block: number, trace: any;
  try {
    const head = Number(await rpc(s, url, "eth_blockNumber", []));
    block = b.block === undefined ? head : Number(b.block);
    if (block > head) throw new Bad("block: not mined yet");
    const at = "0x" + block.toString(16);
    trace = await rpc(s, url, "debug_traceCall", op
      ? await safeRun(s, url, at, from, to, value, data)
      : [{ from, to, value: "0x" + value.toString(16), data }, at, { tracer: "callTracer", tracerConfig: { withLog: true } }]);
  } catch (e) {
    throw e instanceof Bad ? e : new Bad("can't simulate right now", 502);
  }
  const ok = trace?.error ? "reverts" : "ok";
  const moved = ok === "ok" ? changes(trace, from, WETH[chain]) : [];
  const px = await prices(s, chain, moved.map(([t]) => t).filter((t) => t !== "eth"));
  const list: Change[] = [];
  for (const [t, n] of moved) {
    const m = t === "eth" ? { symbol: COIN[chain] || "ETH", decimals: 18 } : await meta(s, chain, t);
    list.push({ token: t, symbol: m.symbol, decimals: m.decimals, amount: n.toString(), usd: usd(n, m.decimals, t === "eth" ? px.eth : px.tokens[t]) });
  }
  const tx = txHash(from, to, value, data, op);
  const sig = sign("sha256", Buffer.from(text(b.nonce, chain, tx, block, ok, list)), { key: s.key, dsaEncoding: "ieee-p1363" });
  return { block, ok, tx, changes: list, nonce: b.nonce, sig: "p256", r: sig.subarray(0, 32).toString("hex"), s: sig.subarray(32).toString("hex") };
}

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST", "Access-Control-Allow-Headers": "Content-Type" };
const reply = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { ...CORS, "Content-Type": "application/json" } });

/** GET: who this is (its public key, its chains). POST: a simulation. */
export async function handle(s: Setup, req: Request, ip: string) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method === "GET") return reply({ name: "clear-sim", version: 1, sig: "p256", ...pub(s.key), chains: Object.keys(s.rpc).map(Number) });
  if (req.method !== "POST") return reply({ error: "GET or POST" }, 405);
  const no = s.limit(ip);
  if (no) return reply({ error: no }, 429);
  const body = await req.text();
  if (body.length > MAX_DATA + 2000) return reply({ error: "too big" }, 413);
  try {
    return reply(await simulate(s, JSON.parse(body)));
  } catch (e) {
    return reply({ error: e instanceof Bad ? e.message : "Bad request." }, e instanceof Bad ? e.status : 400);
  }
}

// Vercel: this file is the function (vercel.json sends every path here). SIM_KEY must be set.
let vs: Setup | null = null;
const vercel = (req: Request) => {
  try { vs ||= setup(process.env); } catch { return reply({ error: "not set up" }, 503); }
  return handle(vs, req, (req.headers.get("x-forwarded-for") || "").split(",")[0].trim());
};
export { vercel as GET, vercel as POST, vercel as OPTIONS };
