// node test/test_loader.js  — THREE/fetch/GLTFLoader をスタブ化して model-loader.js のロジックと異常系を検証
const fs = require('fs'), path = require('path');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
console.warn = () => {};   // 想定内の警告は静かに

// ---- 最小スタブ ----
class V3 { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; } negate() { this.x = -this.x; this.y = -this.y; this.z = -this.z; return this; } }
class Obj {
  constructor() { this.children = []; this.parent = null; this.position = new V3(); this.rotation = { x: 0, y: 0, z: 0 };
    this.scale = { x: 1, y: 1, z: 1, setScalar(s) { this.x = this.y = this.z = s; } }; this.userData = {}; this.localBox = null; this.name = ''; this.isMesh = false; }
  add(o) { o.parent = this; this.children.push(o); } remove(o) { const i = this.children.indexOf(o); if (i >= 0) { this.children.splice(i, 1); o.parent = null; } }
  clone() { const c = new Obj(); c.localBox = this.localBox; c.name = this.name; c.isMesh = this.isMesh; this.children.forEach((ch) => c.add(ch.clone())); return c; }
  traverse(f) { f(this); this.children.forEach((c) => c.traverse(f)); } updateMatrixWorld() {}
  getObjectByName(n) { let r = null; this.traverse((o) => { if (!r && o.name === n) r = o; }); return r; }
}
class Box3 {
  constructor() { this.min = new V3(Infinity, Infinity, Infinity); this.max = new V3(-Infinity, -Infinity, -Infinity); }
  setFromObject(o) { this.min = new V3(Infinity, Infinity, Infinity); this.max = new V3(-Infinity, -Infinity, -Infinity);
    const b = o.localBox; if (!b) return this; const c = Math.cos(o.rotation.y), s = Math.sin(o.rotation.y);
    for (const x of [b[0][0], b[1][0]]) for (const y of [b[0][1], b[1][1]]) for (const z of [b[0][2], b[1][2]]) {
      const X = (x * c + z * s) * o.scale.x + o.position.x, Y = y * o.scale.y + o.position.y, Z = (-x * s + z * c) * o.scale.z + o.position.z;
      this.min.x = Math.min(this.min.x, X); this.min.y = Math.min(this.min.y, Y); this.min.z = Math.min(this.min.z, Z);
      this.max.x = Math.max(this.max.x, X); this.max.y = Math.max(this.max.y, Y); this.max.z = Math.max(this.max.z, Z); }
    return this; }
  isEmpty() { return this.max.x < this.min.x; }
  getSize(t) { return new V3(this.max.x - this.min.x, this.max.y - this.min.y, this.max.z - this.min.z); }
  getCenter(t) { return new V3((this.max.x + this.min.x) / 2, (this.max.y + this.min.y) / 2, (this.max.z + this.min.z) / 2); } }

// GLB の挙動を URL ごとに切り替えるフェイク GLTFLoader
let glbBehaviour = {};
class GLTFLoader { load(url, onLoad, _p, onErr) { const b = glbBehaviour[url];
  if (b === 'hang') return;                         // コールバックを呼ばない
  setTimeout(() => {
    if (!b || b === '404') return onErr(new Error('404 ' + url));
    if (b === 'corrupt') return onErr(new Error('Unexpected token'));
    if (b === 'empty') return onLoad({ scene: new Obj() });
    const sc = new Obj(); const m = new Obj(); m.isMesh = true; m.name = 'Body'; m.localBox = b.box; sc.add(m); sc.localBox = b.box; onLoad({ scene: sc });
  }, 2); } }
global.THREE = { Vector3: V3, Box3, GLTFLoader };

// fetch スタブ
const files = {}; const readJson = (p) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', p), 'utf8'));
global.fetch = (url) => new Promise((res) => setTimeout(() => {
  if (!(url in files)) return res({ ok: false, status: 404, json: async () => { throw new Error('404'); } });
  const v = files[url]; if (v === '__badjson__') return res({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } });
  res({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(v)) }); }, 1));

// ---- 読み込み ----
require('../js/collision-system.js');
require('../js/model-loader.js');
const G = globalThis.GameExt;
const mkTarget = () => { const root = new Obj(); const t = new Obj(); root.add(t); const proc = new Obj(); proc.name = 'procedural'; t.add(proc); return t; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // models.json (実ファイル) + 実コライダー
  files['models/models.json'] = readJson('models/models.json');
  files['collision/37_F-15C.json'] = readJson('collision/37_F-15C.json');
  files['collision/01_Ki-10II.json'] = '__badjson__';          // 壊れたJSON
  files['collision/02_A6M2.json'] = { colliders: [{ type: 'cube' }] };   // 全コライダー不正
  // 正常: F-15C = +Z機首, 全長19.4 / 全幅13 / 全高5.6 (実GLBは未入手のため寸法はmanifest値から作った箱)
  glbBehaviour['models/37_F-15C.glb'] = { box: [[-6.5, -1.5, -9.0], [6.5, 4.1, 10.4]] };
  glbBehaviour['models/01_Ki-10II.glb'] = { box: [[-5, -1, -4], [5, 1, 4]] };
  glbBehaviour['models/02_A6M2.glb'] = { box: [[-6, -1, -4.7], [6, 1.5, 4.7]] };
  glbBehaviour['models/03_N1K2J.glb'] = '404';                   // 存在しないGLB
  glbBehaviour['models/04_JP_F86.glb'] = 'corrupt';              // 破損GLB
  glbBehaviour['models/05_JP_F104.glb'] = 'empty';               // メッシュ無し
  glbBehaviour['models/06_JP_F4.glb'] = 'hang';                  // 応答しない

  await G.models.init({ glbTimeoutMs: 150 });
  ok(G.models.isManifestLoaded(), 'manifest loaded');
  ok(G.models._entries.size === 62, 'manifest has 62 entries: ' + G.models._entries.size);

  // (1) 正常系
  const t1 = mkTarget(); G.models.attach(t1, 'f15c'); await sleep(40);
  const m = t1.userData.glbModel;
  ok(m && t1.children.length === 1 && t1.children[0] === m, 'procedural children replaced by GLB');
  ok(near(m.rotation.y, 0), 'rotationY 0 for new +Z-nose GLB set');
  ok(near(m.scale.x, 11 / 19.4), 'fit scale = 11/maxDim: ' + m.scale.x);
  const bb = new Box3().setFromObject(m), c = bb.getCenter();
  ok(near(c.x, 0, 1e-9) && near(c.y, 0, 1e-9) && near(c.z, 0, 1e-9), 'model re-centred on bbox centre');
  ok(near(bb.max.z - bb.min.z, 11, 1e-9), 'nose-tail length normalised to 11m, nose still +Z (max z>0): ' + bb.max.z.toFixed(2));
  ok(G.collision.has('f15c') && G.collision.status('f15c').state === 'ready', 'collision JSON loaded in parallel');
  ok(G.models.status('f15c') === 'ready', 'status ready');
  // 2体目はキャッシュ共有・独立インスタンス
  const t1b = mkTarget(); G.models.attach(t1b, 'f15c'); await sleep(10);
  ok(t1b.userData.glbModel && t1b.userData.glbModel !== m, 'independent clone per aircraft');

  // (2) 差し替え前に機体が破棄された(parent無し) → 何もしない
  const orphan = new Obj(); G.models.attach(orphan, 'f15c'); await sleep(10);
  ok(orphan.children.length === 0, 'detached target untouched');

  // (3) 異常系: GLB 404 / 破損 / 空 / 無応答 → 従来メッシュ維持・例外なし・whenReady は必ず解決
  const bad = ['n1k2', 'jf86', 'jf104', 'jf4'];
  const targets = bad.map(() => mkTarget()); bad.forEach((id, i) => G.models.attach(targets[i], id));
  const t0 = Date.now();
  const r = await G.models.whenReady(bad, 3000);
  ok(Date.now() - t0 < 1000, 'whenReady returned via failures/timeouts, not 3s: ' + (Date.now() - t0) + 'ms');
  ok(r.failed.length === 4 && r.ready.length === 0, 'all 4 marked failed: ' + JSON.stringify(r));
  ok(targets.every((t) => t.children.length === 1 && t.children[0].name === 'procedural'), 'procedural meshes kept on every failure');
  ok(G.models.errors.some((e) => /404/.test(e)) && G.models.errors.some((e) => /タイムアウト/.test(e)), 'errors reported (404 & timeout)');

  // (4) コライダーJSON異常: モデルは表示でき、当たり判定だけ従来へフォールバック
  const tk = mkTarget(); G.models.attach(tk, 'ki10'); await sleep(40);
  ok(tk.userData.glbModel, 'bad collision JSON does not block the model');
  ok(!G.collision.has('ki10') && G.collision.status('ki10').state === 'failed', 'bad JSON => legacy collision for ki10');
  const ta = mkTarget(); G.models.attach(ta, 'a6m2'); await sleep(40);
  ok(ta.userData.glbModel && !G.collision.has('a6m2'), 'all-invalid colliders => legacy');
  const fake = { spec: { id: 'ki10' }, pos: { x: 0, y: 0, z: 0 }, quat: { x: 0, y: 0, z: 0, w: 1 }, mesh: { scale: { x: 1 } }, isPlayer: false };
  ok(G.collision.segmentHit(fake, { x: 0, y: 0, z: 9 }, { x: 0, y: 0, z: -9 }) === null, 'segmentHit returns null => game uses legacy sphere');

  // (5) whenReady の「読込前に出撃」: 先に呼んでも読込完了を待つ / タイムアウトでも解決
  files['collision/18_Bf109E.json'] = readJson('collision/37_F-15C.json');
  glbBehaviour['models/18_Bf109E.glb'] = { box: [[-5, -1, -4], [5, 1, 4]] };
  const rr = await G.models.whenReady(['bf109e'], 3000);
  ok(rr.ready.includes('bf109e') && !rr.timedOut, 'whenReady waits for load');
  glbBehaviour['models/19_Fw190D-9.glb'] = 'hang';
  const t2 = Date.now(); const r2 = await G.models.whenReady(['fw190d9'], 60);
  ok(r2.timedOut && Date.now() - t2 < 400, 'whenReady times out (60ms) and resolves');
  // 遅れて到着 → 後からでも差し替わる(既存仕様)
  const tl = mkTarget(); glbBehaviour['models/20_EastGer_MiG15bis.glb'] = { box: [[-5, -1, -4], [5, 1, 4]] };
  G.models.attach(tl, 'mig15de'); await sleep(40); ok(tl.userData.glbModel, 'late arrival still swaps model');

  // (6) マニフェスト未記載ID → 規約パス models/<id>.glb
  glbBehaviour['models/newplane.glb'] = { box: [[-4, -1, -5], [4, 1, 5]] }; files['collision/newplane.json'] = readJson('collision/37_F-15C.json');
  const tn = mkTarget(); G.models.attach(tn, 'newplane'); await sleep(40);
  ok(tn.userData.glbModel && G.collision.has('newplane'), 'id not in manifest: convention path models/<id>.glb + collision/<id>.json');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
