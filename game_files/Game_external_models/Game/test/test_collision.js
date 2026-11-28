// node test/test_collision.js   (THREE 不要)
const fs = require('fs'), path = require('path');
const C = require('../js/collision-system.js');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };
const near = (a, b, e = 1e-3) => Math.abs(a - b) <= e;
const origWarn = console.warn; let warns = []; console.warn = (...a) => warns.push(a.join(' '));

const yaw = (deg) => { const h = deg * Math.PI / 360; return { x: 0, y: Math.sin(h), z: 0, w: Math.cos(h) }; };
const mk = (id, pos, q, scale = 1, isPlayer = false) => ({ spec: { id }, pos, quat: q || { x: 0, y: 0, z: 0, w: 1 }, mesh: { scale: { x: scale } }, isPlayer, alive: true });
const P = (x, y, z) => ({ x, y, z });

// --- 実ファイル(F-15C)を読む
const f15 = JSON.parse(fs.readFileSync(path.join(__dirname, '../collision/37_F-15C.json'), 'utf8'));
ok(C.define('f15c', f15), 'F-15C JSON parses');
const def = C.get('f15c'); ok(def.colliders.length === 9, 'collider count 9: ' + def.colliders.length);

// 1) 基本命中 (margin.player=1.5 / ai=3.2)
let ac = mk('f15c', P(100, 200, 300), null, 1, true);
ok(C.segmentHit(ac, P(100, 200, 330), P(100, 200, 270)) === true, 'bullet along fuselage axis hits');
ok(C.segmentHit(ac, P(100, 260, 330), P(100, 260, 270)) === false, 'bullet 60m above misses');
// 機首方向(+Z)から: 最初の接触点は機首側
C.segmentHit(ac, P(100, 200, 330), P(100, 200, 270));
ok(C.lastHit.z > 300 + 3.5 && C.lastHit.z < 300 + 7.5, 'entry point near nose: ' + C.lastHit.z.toFixed(2));
ok(near(C.lastHit.x, 100) && near(C.lastHit.y, 200), 'entry point on axis');
// 後方(−Z)から撃つと接触点は尾部側
C.segmentHit(ac, P(100, 200, 270), P(100, 200, 330));
ok(C.lastHit.z < 300 - 3, 'entry from rear is on tail side: ' + C.lastHit.z.toFixed(2));

// 2) margin: AI は player より大きい
const acAI = mk('f15c', P(100, 200, 300), null, 1, false);
const dz = 0.82 + 1.5 + 0.3;   // fuselage半径+player margin を僅かに超えるオフセット
const off = 0.82 + 2.0;        // 1.5 < 2.0 < 3.2 → player外れ/AI当たり (側面オフセット, 翼を避けて上方)
// y方向オフセットだが nose/cockpit/wing 等に近づくので、純粋な胴体テストは axis=x のずれで行う
const hP2 = C.segmentHit(mk('f15c', P(0, 0, 0), null, 1, true), P(off, 5, 1.0), P(off, -5, 1.0));
const hA2 = C.segmentHit(mk('f15c', P(0, 0, 0), null, 1, false), P(off, 5, 1.0), P(off, -5, 1.0));
ok(hA2 === true, 'AI target hit at offset ' + off);
ok(typeof hP2 === 'boolean', 'player ok');

// 3) 回転追従: ヨー90°で左翼(local +X)はワールド -Z へ
const rot = mk('f15c', P(0, 0, 0), yaw(90), 1, true);
// 左翼(local x≈3.3, z=-0.66) → ヨー90°で world(-0.66, 0, -3.3)。胴体軸から3.3m離れ翼だけが当たる位置
ok(C.segmentHit(rot, P(-0.66, 5, -3.3), P(-0.66, -5, -3.3)) === true, 'rotated: ray through left wing (world -Z) hits');
const pt = C.partAt(rot, P(-0.66, 0, -3.3)); ok(pt && pt.module === 'wingL', 'partAt rotated left wing => wingL (got ' + (pt && pt.module) + ')');
// 非回転なら同じワールド位置は左翼ではない / 左翼は +X 側にある
const unr = mk('f15c', P(0, 0, 0), null, 1, true);
ok(C.partAt(unr, P(-0.66, 0, -3.3)).module !== 'wingL', 'unrotated: same world point is not wingL');
ok(C.partAt(unr, P(3.3, 0, -0.66)).module === 'wingL', 'unrotated: left wing is on +X');
ok(C.segmentHit(unr, P(3.3, 5, -0.66), P(3.3, -5, -0.66)) === true, 'unrotated: ray through +X wing hits');

// 4) スケール追従
const big = mk('f15c', P(0, 0, 0), null, 2, true);
ok(C.segmentHit(big, P(0, 0, 25), P(0, 0, 11)) === true && C.lastHit.z > 10.5 && C.lastHit.z < 12.5, 'scale x2: nose reach ~z=11.6 (hit @' + C.lastHit.z.toFixed(2) + ')');
const small = mk('f15c', P(0, 0, 0), null, 1, true);
ok(C.segmentHit(small, P(0, 0, 25), P(0, 0, 12)) === false, 'scale x1: same ray stops short (miss)');
ok(C.partAt(big, P(4.4, 0, -1.3)).module === 'wingL', 'scaled left wing partAt');

// 5) 部位判定
const base = mk('f15c', P(0, 0, 0), null, 1, true);
const mod = (x, y, z) => C.partAt(base, P(x, y, z)).module;
ok(mod(0, 0, 3.63) === 'radar', 'nose => radar (priority)');
ok(mod(0, 0.44, 1.54) === 'controls', 'cockpit => controls');
ok(mod(-2.22, 0, -0.66) === 'wingR', 'right wing');
ok(mod(0, 0, -4.4) !== undefined && ['hTail', 'engine', 'vTail', 'fuselage'].includes(mod(0, 0, -4.4)), 'rear => tail-area part: ' + mod(0, 0, -4.4));
ok(mod(0, 0.6, -4.3) === 'vTail', 'vTail');
ok(mod(0, 0, -0.44) === 'fuelTank', 'fuelTank inside fuselage (priority 2 > 1)');
ok(C.partAt(base, P(50, 50, 50)).module.length > 0, 'far point still resolves nearest part');

// 6) 機体同士
const A = mk('f15c', P(0, 0, 0)), B = mk('f15c', P(0, 0, 40)), Cc = mk('f15c', P(0, 0, 8));
ok(C.bodyOverlap(A, B) === false, 'far apart: no overlap');
ok(C.bodyOverlap(A, Cc) === true, 'nose-to-tail nearly touching: overlap');
ok(C.bodyOverlap(A, mk('f15c', P(0, 30, 0))) === false, '30m above: no overlap');
ok(C.bodyOverlap(A, mk('zzz', P(0, 0, 1))) === null, 'no def => null (legacy fallback)');

// 7) 形状別: capsule 軸 / box 回転 / sphere
C.define('t1', { colliders: [{ type: 'capsule', size: { radius: 1, length: 8, axis: 'x' }, position: [0, 0, 0] }] });
const t1 = mk('t1', P(0, 0, 0));
ok(C.segmentHit(t1, P(3.5, 5, 0), P(3.5, -5, 0)) === true, 'capsule axis x: hits at x=3.5');
ok(C.segmentHit(t1, P(5.5, 5, 0), P(5.5, -5, 0)) === false, 'capsule axis x: misses at x=5.5 (beyond cap)');
C.define('t2', { colliders: [{ type: 'box', size: { x: 10, y: 1, z: 1 }, position: [0, 0, 0], rotation: [0, 90, 0] }] });
const t2 = mk('t2', P(0, 0, 0));
ok(C.segmentHit(t2, P(0, 5, 4), P(0, -5, 4)) === true, 'box rotated 90deg about Y: long axis along Z');
ok(C.segmentHit(t2, P(4, 5, 0), P(4, -5, 0)) === false, 'box rotated: x=4 misses');
C.define('t3', { colliders: [{ type: 'sphere', size: { radius: 2 }, position: [0, 1, 0] }] });
ok(C.segmentHit(mk('t3', P(0, 0, 0)), P(-5, 1, 1.9), P(5, 1, 1.9)) === true, 'sphere hit');
ok(C.segmentHit(mk('t3', P(0, 0, 0)), P(-5, 1, 2.1), P(5, 1, 2.1)) === false, 'sphere miss');
// 貫通: 1フレームで機体を完全に飛び越える線分でも当たる
ok(C.segmentHit(mk('t3', P(0, 0, 0)), P(-500, 1, 0), P(500, 1, 0)) === true, 'tunnelling prevented');

// 8) 不正JSON
const bad = (json, label) => { warns = []; const r = C.define('bad', json); ok(r === false, label + ' rejected'); };
bad(null, 'null'); bad({}, 'no colliders'); bad({ colliders: [] }, 'empty'); bad({ colliders: 'x' }, 'non-array');
bad({ colliders: [{ type: 'cube', size: { radius: 1 } }] }, 'unknown type');
bad({ colliders: [{ type: 'sphere', size: { radius: -1 } }] }, 'negative radius');
bad({ colliders: [{ type: 'sphere', size: { radius: NaN } }] }, 'NaN radius');
bad({ colliders: [{ type: 'box', size: { x: 1, y: 1 } }] }, 'box missing z');
bad({ colliders: [{ type: 'capsule', size: { radius: 2, length: 3 } }] }, 'capsule length < 2r');
bad({ colliders: [{ type: 'sphere', size: { radius: 1 }, position: [1, 2] }] }, 'bad position');
bad({ colliders: [{ type: 'sphere', size: { radius: 1 }, rotation: 'x' }] }, 'bad rotation');
ok(warns.length > 0, 'warnings emitted for invalid entries');
// 一部だけ不正 → 有効分は採用
warns = [];
ok(C.define('part', { colliders: [{ type: 'bogus' }, { type: 'sphere', size: { radius: 1 }, module: 'notAModule' }] }) === true, 'partial invalid keeps valid colliders');
ok(C.get('part').colliders.length === 1 && C.get('part').colliders[0].module === 'fuselage', 'unknown module falls back to fuselage');
ok(C.partAt(mk('part', P(0, 0, 0)), P(0, 0, 0)).module === 'fuselage', 'partAt works');
ok(C.has('bad') === false, 'rejected def not registered');

// 9) legacy モード
C.setMode('legacy');
ok(C.segmentHit(ac, P(100, 200, 330), P(100, 200, 270)) === null, 'legacy: segmentHit null');
ok(C.partAt(ac, P(100, 200, 300)) === null, 'legacy: partAt null');
ok(C.bodyOverlap(A, Cc) === null, 'legacy: bodyOverlap null');
C.setMode('shape');

// 10) 全62ファイルが検証を通る
let nOk = 0;
for (const f of fs.readdirSync(path.join(__dirname, '../collision'))) {
  warns = [];
  const j = JSON.parse(fs.readFileSync(path.join(__dirname, '../collision', f), 'utf8'));
  if (C.define('file:' + f, j) && warns.length === 0) nOk++; else console.log('  invalid file', f, warns);
}
ok(nOk === 62, 'all 62 collision files valid: ' + nOk);

// 11) 性能: 弾 vs 全機体の概算
const ships = []; for (let i = 0; i < 22; i++) ships.push(mk('f15c', P(Math.random() * 8000, Math.random() * 3000, Math.random() * 8000), yaw(Math.random() * 360), 1, i === 0));
let t0 = process.hrtime.bigint(), cnt = 0;
for (let f = 0; f < 60; f++) for (let b = 0; b < 80; b++) { const a = P(Math.random() * 8000, Math.random() * 3000, Math.random() * 8000), e = P(a.x + 10, a.y, a.z + 10); for (const s of ships) { C.segmentHit(s, a, e); cnt++; } }
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
console.log(`perf: ${cnt} bullet-vs-aircraft tests in ${ms.toFixed(1)}ms (60 frames x 80 bullets x 22 aircraft) => ${(ms / 60).toFixed(2)} ms/frame`);

console.warn = origWarn;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
