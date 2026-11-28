#!/usr/bin/env python3
"""
models/models.json と collision/*.json の「初期値」を生成するツール。

使い方（Game フォルダで）:
    python tools/gen_defaults.py <manifest.csv> [index.html]

* manifest.csv : GLB納品物の manifest.csv（file / airframe / length_m / span_m / height_m 列を使用）
* index.html   : 機体ID と世代(g) をゲーム側から読むために使用（省略時は ./index.html）

生成される collision/*.json は manifest の全長・全幅・全高から作った「概算の当たり判定」です。
GLBの実形状に合わせたものではありません。?colDebug=1 付きで起動して目視しながら
JSON の数値を手で調整してください（このスクリプトを再実行すると上書きされます）。
"""
import csv, json, os, re, sys

FIT_SIZE = 11.0   # ゲーム側の既存正規化値（applyAircraftModel の最大寸法 11m）

def r2(v):
    return round(float(v), 2)

def build(length, span, height, is_prop):
    """機体ローカル座標(+Z機首/+X左翼/+Y上, 最大寸法=FIT_SIZE に正規化後, 中心=バウンディングボックス中心)"""
    s = FIT_SIZE / max(length, span, height)
    l, w, h = length * s, span * s, height * s
    rf = max(0.075 * l, 0.45)                       # 胴体半径
    cols = []

    def add(id_, type_, module, pos, size, prio, rot=(0, 0, 0), dmg=1.0):
        cols.append({
            "id": id_, "type": type_, "target": id_, "module": module,
            "position": [r2(v) for v in pos], "rotation": list(rot),
            "size": size, "damageMultiplier": dmg, "priority": prio
        })

    add("fuselage", "capsule", "fuselage", (0, 0, -0.01 * l),
        {"radius": r2(rf), "length": r2(0.94 * l), "axis": "z"}, 1)
    if is_prop:
        add("engine", "sphere", "engine", (0, 0, 0.33 * l), {"radius": r2(max(0.1 * l, 0.5))}, 3)
    else:
        add("nose", "sphere", "radar", (0, 0, 0.33 * l), {"radius": r2(max(0.07 * l, 0.4))}, 3)
        add("engine", "capsule", "engine", (0, 0, -0.34 * l),
            {"radius": r2(max(0.07 * l, 0.4)), "length": r2(max(0.28 * l, 0.14 * l + 0.1)), "axis": "z"}, 2)
    add("cockpit", "sphere", "controls", (0, 0.04 * l, 0.14 * l), {"radius": r2(max(0.055 * l, 0.35))}, 3)
    add("fuelTank", "box", "fuelTank", (0, 0, -0.04 * l),
        {"x": r2(1.4 * rf), "y": r2(1.4 * rf), "z": r2(0.2 * l)}, 2)
    chord = (0.20 if is_prop else 0.24) * l
    thick = max(0.25, 0.04 * h)
    wz = (0.02 if is_prop else -0.06) * l
    for name, sign in (("wingL", 1), ("wingR", -1)):
        add(name, "box", name, (sign * 0.30 * w, 0, wz), {"x": r2(0.40 * w), "y": r2(thick), "z": r2(chord)}, 3)
    add("hTail", "box", "hTail", (0, 0, -0.41 * l), {"x": r2(0.30 * w), "y": r2(thick), "z": r2(0.12 * l)}, 3)
    add("vTail", "box", "vTail", (0, 0.22 * h, -0.39 * l), {"x": r2(max(0.3, 0.04 * w)), "y": r2(0.42 * h), "z": r2(0.14 * l)}, 3)
    return {
        "version": 1,
        "units": "game-meters (entity local, model scaled to %gm max dimension)" % FIT_SIZE,
        "coordinateSystem": "+Z=nose, +Y=up, +X=left wing; origin=model bounding-box center",
        "margin": {"player": 1.5, "ai": 3.2, "body": 1.5},
        "colliders": cols
    }

def dump_compact(data):
    """読みやすさ重視: 1コライダー=1行"""
    head = {k: v for k, v in data.items() if k != "colliders"}
    lines = ["{"]
    for k, v in head.items():
        lines.append("  %s: %s," % (json.dumps(k), json.dumps(v, ensure_ascii=False)))
    lines.append('  "colliders": [')
    cs = data["colliders"]
    for i, c in enumerate(cs):
        lines.append("    " + json.dumps(c, ensure_ascii=False) + ("," if i < len(cs) - 1 else ""))
    lines.append("  ]")
    lines.append("}")
    return "\n".join(lines) + "\n"

def main():
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(1)
    manifest = sys.argv[1]
    html = sys.argv[2] if len(sys.argv) > 2 else "index.html"
    root = os.path.dirname(os.path.abspath(__file__)) + "/.."
    src = open(html, encoding="utf-8").read()
    pairs = [(m[1], int(m[2])) for m in re.findall(r"\{n:'(\w+)',id:'(\w+)',g:(\d+)", src)]
    gens = dict(pairs)
    ids = [p[0] for p in pairs]                       # ゲーム内の機体ID(定義順)
    rows = list(csv.DictReader(open(manifest, encoding="utf-8-sig")))
    # manifest.csv の no 順 = ゲームの機体定義順 (1対1)。件数が違う場合は中止
    if len(ids) != len(rows):
        sys.exit("件数不一致: ゲーム %d機 / manifest %d行。対応表を手動で作成してください" % (len(ids), len(rows)))
    rows.sort(key=lambda r: int(r["no"]))

    models = {}
    os.makedirs(root + "/collision", exist_ok=True)
    os.makedirs(root + "/models", exist_ok=True)
    for id_, r in zip(ids, rows):
        f = r["file"]
        print("%-9s <- %s" % (id_, f))
        base = os.path.splitext(f)[0]
        models[id_] = {"model": f, "collision": base + ".json"}
        is_prop = gens.get(id_, 9) <= 3
        data = build(float(r["length_m"]), float(r["span_m"]), float(r["height_m"]), is_prop)
        data["name"] = r["source_name"]
        with open(root + "/collision/" + base + ".json", "w", encoding="utf-8") as fp:
            fp.write(dump_compact(data))

    manifest_json = {
        "version": 1,
        "_comment": "機体ID → GLB / 当たり判定JSON の対応表。ファイルの追加・交換はここを書き換えるだけ(HTML編集不要)。"
                    "未記載のIDは models/<id>.glb と collision/<id>.json を自動で探します。",
        "defaults": {
            "modelDir": "models/", "collisionDir": "collision/",
            "rotationY": 0,
            "fit": {"mode": "maxDimension", "size": FIT_SIZE, "recenter": True}
        },
        "models": models
    }
    with open(root + "/models/models.json", "w", encoding="utf-8") as fp:
        json.dump(manifest_json, fp, ensure_ascii=False, indent=1)
        fp.write("\n")
    print("generated %d collision files + models/models.json" % len(rows))

if __name__ == "__main__":
    main()
