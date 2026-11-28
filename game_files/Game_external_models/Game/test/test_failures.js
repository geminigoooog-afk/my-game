// node test/test_failures.js <scenario>  scenario = nomanifest | badmanifest | noloader
const scenario = process.argv[2]; console.warn = () => {};
let ok = true; const check = (c, m) => { if (!c) { ok = false; console.log('  FAIL:', scenario, m); } };
class Obj { constructor() { this.children = []; this.parent = {}; } }
if (scenario !== 'noloader') global.THREE = { GLTFLoader: class { load(u, a, b, err) { setTimeout(() => err(new Error('404')), 1); } }, Vector3: class {}, Box3: class {} };
else global.THREE = { Vector3: class {}, Box3: class {} };            // GLTFLoader 無し(CDN失敗)
global.fetch = (u) => Promise.resolve(scenario === 'badmanifest' && u.endsWith('models.json')
  ? { ok: true, status: 200, json: async () => { throw new SyntaxError('x'); } } : { ok: false, status: 404, json: async () => { throw new Error('404'); } });
require('../js/collision-system.js'); require('../js/model-loader.js');
const G = globalThis.GameExt;
(async () => {
  try {
    await G.models.init();
    const t = new Obj(); t.children.push({ n: 'proc' });
    G.models.attach(t, 'f15c');
    const r = await G.models.whenReady(['f15c', 'ki10'], 2000);
    check(r.ready.length === 0 && r.failed.length === 2, 'both marked failed: ' + JSON.stringify(r));
    check(t.children.length === 1 && t.children[0].n === 'proc', 'procedural kept');
    check(G.models.errors.length > 0, 'error recorded');
    check(G.collision.segmentHit({ spec: { id: 'f15c' }, pos: {}, quat: {}, mesh: {} }, {}, {}) === null, 'collision falls back (null)');
  } catch (e) { ok = false; console.log('  FAIL: exception escaped', e); }
  console.log(scenario, ok ? 'OK' : 'NG'); process.exit(ok ? 0 : 1);
})();
