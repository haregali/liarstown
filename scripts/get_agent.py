#!/usr/bin/env python3
"""Plays liars.town using ONLY GET requests (the zero-install protocol), with an LLM deciding.
Usage: OPENROUTER_API_KEY=... python get_agent.py <token> [games]
"""
import json, os, re, sys, time, urllib.parse, urllib.request

SITE = os.environ.get("LIARS_SITE", "https://liars.town")
KEY = os.environ["OPENROUTER_API_KEY"]
MODEL = os.environ.get("MODEL", "deepseek/deepseek-v4-flash")
token = sys.argv[1]
max_games = int(sys.argv[2]) if len(sys.argv) > 2 else 1

def get(url, timeout=40):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "liars-town-get-agent/0.1"}), timeout=timeout) as r:
        return r.read().decode()

def llm(system, user):
    body = json.dumps({"model": MODEL, "max_tokens": 700, "reasoning": {"effort": "low", "exclude": True}, "temperature": 0.9,
                       "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}).encode()
    req = urllib.request.Request("https://openrouter.ai/api/v1/chat/completions", data=body,
                                 headers={"authorization": f"Bearer {KEY}", "content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return (json.load(r)["choices"][0]["message"].get("content") or "SAY: I am still thinking this through.").strip()

SYSTEM = ("You are an agent playing Werewolf on liars.town via a text interface. You will be shown the page. "
          "Decide your action. Reply with ONLY one line: either SAY: <speech under 400 chars> or NAME: <one of the listed option names>. "
          "Play to win for your role; be specific about what others said.")

games_done, last_game_over = 0, None
while True:
    page = get(f"{SITE}/play?token={token}")
    if "GAME OVER" in page.splitlines()[0]:
        gid = page.splitlines()[0].split("game ")[1].split(" ")[0]
        if gid != last_game_over:
            last_game_over = gid; games_done += 1
            print(f"== game over: {page.splitlines()[0]}")
            if games_done >= max_games:
                break
        time.sleep(3); continue
    if "ACTION REQUIRED" not in page:
        print(".", end="", flush=True); continue
    m = re.search(r"ACTION REQUIRED.*", page)
    print("\n" + m.group(0)[:100])
    reply = llm(SYSTEM, page)
    if reply.upper().startswith("SAY:"):
        q = "say=" + urllib.parse.quote(reply[4:].strip()[:420])
    else:
        name = reply.split(":", 1)[-1].strip().strip(".")
        q = ("vote=" if "vote=NAME" in page else "target=") + urllib.parse.quote(name)
    res = get(f"{SITE}/play?token={token}&{q}")
    print("  ->", q[:120], "|", res.splitlines()[0][:80])
print("done")
