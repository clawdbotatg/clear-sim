# clear-sim v1

## Ask

`POST /` with JSON:

| field | |
|---|---|
| `chain` | chain id, a number |
| `from`, `to` | addresses, hex |
| `value` | wei, a decimal string |
| `data` | calldata, hex (up to 200,000 chars) |
| `nonce` | 32 lowercase hex, picked by the wallet: an old answer can't be replayed |
| `operation` | optional: `0` (a call, the default) or `1` (a delegatecall from a Safe, as it runs a MultiSend batch: simulated as the Safe's own `execTransaction`, called by one of its owners) |
| `block` | optional: simulate at this block. Default: the latest. Several simulators at one block give identical answers |
| `sig` | optional: the signature scheme the wallet can check. Only `p256` (the default) |

`GET /` gives `{name, version, sig, x, y, chains}`: the public key (x, y: 64 hex each) and the chains it serves.

## Answer

| field | |
|---|---|
| `block` | the block it ran on |
| `ok` | `ok` or `reverts` (then `changes` is empty) |
| `tx` | sha256 hex of `<from>\n<to>\n<value>\n<data>`, all lowercase, value in decimal; with `\n1` after it for operation 1 |
| `changes` | the sender's net change per token: `token` (`eth` = the chain's coin, else the token's address), `symbol` (`?` if the token won't say, or says something odd), `decimals` (-1 if unknown), `amount` (raw units, signed, `-` = out), `usd` (the whole change in dollars, 2 decimals, `""` = no price) |
| `nonce`, `sig` | as asked |
| `r`, `s` | the signature, 64 hex each |

Counted: ETH moved by calls (not by DELEGATECALL), ERC-20 `Transfer` events, and wrapping or unwrapping each
chain's WETH. Frames that revert don't count. Not counted: NFTs, approvals.

Errors: `{error}` with 400 (bad ask), 404 (no such chain), 413, 429 (limits), 502 (RPC down), 503 (not set up).

## Signature

P-256 over sha256 of this text, lines joined with `\n`:

```
clear-sim v1
<nonce>
<chain>
<tx>
<block>
<ok>
<token>,<symbol>,<decimals>,<amount>,<usd>     one line per change, in the answer's order
```

`r` and `s` are the raw signature (IEEE P1363).

## Checking it (the wallet)

1. Work out `tx` from what you were asked to sign. Don't take it from the answer.
2. Rebuild the text with your own nonce, chain and tx, and the answer's other fields. Check the signature against a
   key on your list.
3. Check the answer against the transaction: ETH out must equal its value. Tokens in should be at least the
   transaction's own minimum, where you can read one.
4. Show it as the simulator's word for names and prices.
