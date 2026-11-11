#!/usr/bin/env python3
"""Validate sentences.jsonl for the blind translation comparison. Standard library only."""
import json, os, sys, collections

PATH = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "sentences.jsonl")
KEYS = ["id", "conv", "seq", "src", "tgt", "text", "address", "tags"]
ES_TGTS = ["es-AR", "es-CO", "es-MX", "es-ES"]

raw = open(PATH, "rb").read()
raw.decode("utf-8")  # raises on invalid UTF-8
assert "\u2013" not in raw.decode("utf-8") and "\u2014" not in raw.decode("utf-8"), "en or em dash found"
lines = raw.decode("utf-8").splitlines()
assert len(lines) == 625, f"expected 625 lines, got {len(lines)}"
rows = [json.loads(l) for l in lines]

for i, r in enumerate(rows, 1):
    assert list(r.keys()) == KEYS, f"line {i}: keys {list(r.keys())}"
    assert r["id"] == f"b{i:04d}", f"line {i}: id {r['id']}"
    assert r["address"] in ("singular", "plural", "none"), r
    assert isinstance(r["tags"], list) and all(isinstance(t, str) for t in r["tags"]), r
    assert isinstance(r["seq"], int) and r["text"].strip() == r["text"] and r["text"], r
    n = len(r["text"].split())
    assert 2 <= n <= 40, f"{r['id']}: {n} words"

texts = [r["text"] for r in rows]
dupes = [t for t, c in collections.Counter(texts).items() if c > 1]
assert not dupes, f"duplicate texts: {dupes}"
norm = [" ".join(t.lower().replace(",", "").replace(".", "").replace("?", "").replace("¿", "").split()) for t in texts]
assert len(set(norm)) == 625, "near duplicate texts (case/punctuation only)"

tgt = collections.Counter(r["tgt"] for r in rows)
assert tgt == {"es-AR": 125, "es-CO": 125, "es-MX": 125, "es-ES": 125, "en-US": 125}, tgt
for t in ES_TGTS:
    src = collections.Counter(r["src"] for r in rows if r["tgt"] == t)
    assert set(src) == {"en-US", "en-GB"}, (t, src)
    assert 95 <= src["en-US"] <= 105 and 20 <= src["en-GB"] <= 30, (t, src)
src_en = collections.Counter(r["src"] for r in rows if r["tgt"] == "en-US")
assert sorted(src_en.values()) == [31, 31, 31, 32] and set(src_en) == {"es-AR", "es-CO", "es-MX", "es-ES"}, src_en

for t in ES_TGTS + ["en-US"]:
    sub = [r for r in rows if r["tgt"] == t]
    sg = sum(r["address"] == "singular" for r in sub)
    pl = sum(r["address"] == "plural" for r in sub)
    assert sg >= 45, (t, "singular", sg)
    if t in ES_TGTS:
        assert pl >= 12, (t, "plural", pl)

convs = collections.OrderedDict()
for i, r in enumerate(rows):
    convs.setdefault(r["conv"], []).append((i, r))
for cid, items in convs.items():
    idx = [i for i, _ in items]
    assert idx == list(range(idx[0], idx[0] + len(idx))), f"{cid} not consecutive"
    assert 3 <= len(items) <= 6, f"{cid} has {len(items)} lines"
    assert len({(r["src"], r["tgt"]) for _, r in items}) == 1, f"{cid} mixes src/tgt"
    assert [r["seq"] for _, r in items] == list(range(1, len(items) + 1)), f"{cid} seq"

print("OK: all assertions passed")
print(f"lines {len(rows)}, convs {len(convs)}, unique texts {len(set(texts))}")
for t in ES_TGTS + ["en-US"]:
    sub = [r for r in rows if r["tgt"] == t]
    src = dict(sorted(collections.Counter(r["src"] for r in sub).items()))
    addr = dict(sorted(collections.Counter(r["address"] for r in sub).items()))
    lens = collections.Counter("short" if len(r["text"].split()) <= 6 else "long" if len(r["text"].split()) >= 19 else "medium" for r in sub)
    tags = collections.Counter(tg for r in sub for tg in r["tags"] if tg not in ("short", "long"))
    nconv = len({r["conv"] for r in sub})
    print(f"{t}: n={len(sub)} convs={nconv} src={src} address={addr} "
          f"length=short {lens['short']}/medium {lens['medium']}/long {lens['long']} tags={dict(sorted(tags.items()))}")
