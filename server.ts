// Run clear-sim on your own machine: node server.ts (reads .env). The first run makes a key and keeps it in .sim-key.
import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { setup, handle, pub } from "./api/sim.ts";

if (existsSync(".env")) process.loadEnvFile(".env");
if (!process.env.SIM_KEY) {
  if (!existsSync(".sim-key")) {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    writeFileSync(".sim-key", privateKey.export({ format: "der", type: "pkcs8" }).toString("base64") + "\n", { mode: 0o600 });
    console.log("made a new key: .sim-key (keep it; back it up)");
  }
  process.env.SIM_KEY = readFileSync(".sim-key", "utf8").trim();
}
const s = setup(process.env);
if (!Object.keys(s.rpc).length) throw new Error("no chains: set ALCHEMY_API_KEY or RPC_1=<url>");
const port = Number(process.env.PORT) || 8645, k = pub(s.key);

createServer(async (q, a) => {
  const parts: Buffer[] = [];
  for await (const c of q) parts.push(c as Buffer);
  const body = q.method === "POST" ? Buffer.concat(parts) : undefined;
  const r = await handle(s, new Request("http://x" + q.url, { method: q.method, headers: q.headers as any, body }), q.socket.remoteAddress || "");
  a.writeHead(r.status, Object.fromEntries(r.headers));
  a.end(Buffer.from(await r.arrayBuffer()));
}).listen(port, () => {
  console.log(`clear-sim on http://localhost:${port}  chains ${Object.keys(s.rpc).join(",")}`);
  console.log(`public key  x ${k.x}\n            y ${k.y}`);
});
