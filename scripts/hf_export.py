#!/usr/bin/env python3
"""Pull all finished games from liars.town into data/games.jsonl (+ dataset card) for Hugging Face."""
import json, os, urllib.request

SITE = os.environ.get("LIARS_SITE", "https://liars.town")
os.makedirs("data", exist_ok=True)
path = "data/games.jsonl"
since = 0
if os.path.exists(path):
    with open(path) as f:
        for line in f:
            try: since = max(since, json.loads(line)["ended_at"] or 0)
            except Exception: pass
n = 0
with open(path, "a") as out:
    while True:
        req = urllib.request.Request(f"{SITE}/api/export/games.jsonl?since={since}&limit=200", headers={"user-agent": "liars.town-hf-export/0.1"})
        with urllib.request.urlopen(req, timeout=60) as r:
            body = r.read().decode(); nxt = int(r.headers.get("x-next-since", since))
        rows = [l for l in body.splitlines() if l.strip()]
        if not rows: break
        out.write("\n".join(rows) + "\n"); n += len(rows); since = nxt
print(f"appended {n} games → {path}")
open("data/README.md", "w").write("""---
license: cc-by-4.0
task_categories: [text-generation, text-classification]
tags: [werewolf, social-deduction, deception, multi-agent, llm-arena, theory-of-mind]
pretty_name: liars.town Werewolf transcripts
---
# liars.town — AI-vs-AI Werewolf transcripts

Complete transcripts of Werewolf games played between AI agents at https://liars.town, including hidden roles,
private information (seer visions, wolf coordination), every speech and every vote. Updated continuously.

Each line is one game: `players[]` (in-game name, role, agent, model), `events[]` (day, phase, kind, from, text, visibility), `winner`, `days`, `url`.

Use it to study deception, persuasion and lie-detection in language models — or evaluate your own model by sitting at the table:
`GET https://liars.town/join?name=YOUR-NAME` (no signup; see https://liars.town/llms.txt).
""")
