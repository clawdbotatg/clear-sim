# clear-sim

A small server that runs an Ethereum transaction without sending it, and says what moves in and out of the sender's
wallet. It signs the answer with P-256, so a hardware wallet can check it came from this server and the computer in
the middle didn't change it.

Made for the [wedgie](https://wedgie.dev). Any wallet can use it.

```
POST {"chain":1,"from":"0xd8da...","to":"0xc02a...","value":"10000000000000000","data":"0xd0e30db0","nonce":"<32 hex>"}

{"block":26271588,"ok":"ok","changes":[
  {"token":"eth","symbol":"ETH","decimals":18,"amount":"-10000000000000000","usd":"-23.55"},
  {"token":"0xc02a...","symbol":"WETH","decimals":18,"amount":"10000000000000000","usd":"23.54"}],
 "tx":"4943...","nonce":"...","sig":"p256","r":"...","s":"..."}
```

The format and how to check it: [SPEC.md](SPEC.md).

## Run your own

Needs Node 24+ and an RPC that allows `debug_traceCall` (Alchemy does; so does your own node with the debug API).

```
git clone https://github.com/clawdbotatg/clear-sim && cd clear-sim
echo ALCHEMY_API_KEY=... > .env
npm start
```

The first run makes a key in `.sim-key` and prints its public half. Add that to your wallet's list of simulators.
Back up `.sim-key`. Run it on a different machine from the one your wallet is plugged into: a hacked computer
controls a simulator running on itself too.

Docker: `docker build -t clear-sim . && docker run -p 8645:8645 --env-file .env -v $PWD/.sim-key:/app/.sim-key clear-sim`

Vercel: import the repo, set `SIM_KEY` and `ALCHEMY_API_KEY`.

## Settings

| | |
|---|---|
| `ALCHEMY_API_KEY` | all of Alchemy's chains, and prices |
| `RPC_<chain>` | a chain's RPC URL, e.g. `RPC_1=http://localhost:8545`. Overrides Alchemy for that chain |
| `SIM_KEY` | the key, base64 PKCS#8 DER. Not set: `.sim-key` (made on first run) |
| `PORT` | default 8645 |
| `PER_MIN`, `PER_DAY` | per IP, default 60 and 2,000 |
| `ALL_DAY` | all IPs, default 20,000 a day |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | a note when `ALL_DAY` is hit |

Limits are kept in memory. On Vercel each instance counts on its own.

## What it can and can't lie about

A simulator can lie about token names and prices. It can't make the wallet send more ETH than the transaction says,
or accept less than the transaction's own minimum: the wallet checks those against the transaction itself. To guard
against one bad simulator, ask several and need most to agree (the `block` field makes honest answers identical).

## Files

- `api/sim.ts`: the whole server. It's also the Vercel function.
- `server.ts`: runs it with Node.
- `test/`: `npm test`, no network.
