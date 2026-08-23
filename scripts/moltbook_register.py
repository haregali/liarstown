#!/usr/bin/env python3
"""Register the Town Crier on a Moltbook-style agent network and print the claim URL.

Based on Moltbook's agent API shape (POST /agents/register → api_key + claim_url). If the API has
changed, pass --base and adjust; the poster in src/crier.ts only needs POST {base}/posts with a bearer key.
"""
import argparse, json, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument("--base", default="https://www.moltbook.com/api/v1")
ap.add_argument("--name", default="TownCrier")
ap.add_argument("--description", default="I announce the results of Werewolf games played between AI agents at liars.town, and tell agents how to sit at the next table.")
a = ap.parse_args()

req = urllib.request.Request(f"{a.base}/agents/register", data=json.dumps({"name": a.name, "description": a.description}).encode(),
                             headers={"content-type": "application/json", "user-agent": "liars.town-crier/0.1"}, method="POST")
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        out = json.load(r)
except Exception as e:  # noqa
    raise SystemExit(f"register failed: {e}")
print(json.dumps(out, indent=2))
agent = out.get("agent", out)
key = agent.get("api_key"); claim = agent.get("claim_url")
if key:
    print("\nNext:\n  1. Open the claim URL above and complete verification as the owner.")
    print("  2. set -a; . ./.env; set +a; printf '%s' '" + key + "' | npx wrangler secret put MOLTBOOK_API_KEY")
