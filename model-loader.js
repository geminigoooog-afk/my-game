/* =====================================================================
 * model-loader.js  -  外部GLBモデル読み込みシステム
 *
 *  - models/models.json（機体ID → GLB / 当たり判定JSON の対応表）を読み込む
 *  - GLB は既存と同じ THREE.GLTFLoader (r128) で読み込み、同一ファイルはキャッシュ共有
 *  - 失敗（ファイル無し/破損/タイムアウト/ローダー無し）しても例外を外へ出さず、
 *    呼び出し側は従来の手続き生成メッシュをそのまま使い続ける
 *  - 当たり判定JSONは collision-system.js 側で並行して読み込む（モデルとは独立）
 *
 *  公開API (window.GameExt.models):
 *    init(opts)                  マニフェスト読込を開始（多重呼び出し可）
 *    attach(targetGroup, id)     読み込めたら targetGroup の子をGLBに差し替える
 *    whenReady(ids, timeoutMs)   指定機体の読込完了(または失敗/タイムアウト)まで待つ。reject しない
 *    prefetch(ids)               バックグラウンドで先読み
 *    status(id) / errors / report()
 * ===================================================================== */
(function (global) {
  'use strict';
  const NS = global.GameExt = global.GameExt || {};

  const cfg = {
    manifestUrl: 'models/models.json',
    modelDir: 'models/',
    collisionDir: 'collision/',
    manifestTimeoutMs: 8000,
    glbTimeoutMs: 20000,
    startWaitMs: 8000,
    fit: { mode: 'maxDimension', size: 11, recenter: true },   // 既存の正規化(最大寸法11m・中心合わせ)を踏襲
    rotationYDeg: 0
  };
  const entries = new Map();        // id -> 正規化済みマニフェストエントリ
  const records = new Map();        // id -> { phase, promise, rec, error }
  const glbCache = new Map();       // url -> Promise<Object3D|null>
  const errors = [];
  const reported = new Set();
  let manifestPromise = null;
  let manifestOk = false;
  let gltfLoader = null;

  function warn(msg) {
    if (reported.has(msg)) return;
    reported.add(msg);
    errors.push(msg);
    try { console.warn('[GameExt/models] ' + msg); } catch (e) {}
  }
  const isNum = (v) => typeof v === 'number' && isFinite(v);
  const baseName = (p) => String(p).replace(/^.*[\\/]/, '');
  const withDir = (dir, p) => (/^(https?:)?\/\//.test(p) || p.startsWith('/') || p.startsWith(dir)) ? p : dir + p;

  // ---------------------------------------------------------------
  // マニフェスト
  // ---------------------------------------------------------------
  function normalizeEntry(id, raw) {
    const e = {
      id, modelUrl: null, collisionUrl: null,
      rotationYDeg: cfg.rotationYDeg, fit: Object.assign({}, cfg.fit), offset: [0, 0, 0], visualParts: null
    };
    const obj = (typeof raw === 'string') ? { model: raw } : raw;
    if (!obj || typeof obj !== 'object' || typeof obj.model !== 'string' || !obj.model) {
      warn(`models.json: "${id}" の指定が不正です("model" に文字列でGLBファイル名を指定)。規約パスで試行します`);
      return conventionEntry(id);
    }
    e.modelUrl = withDir(cfg.modelDir, obj.model);
    if (obj.collision === null || obj.collision === false) e.collisionUrl = null;
    else if (typeof obj.collision === 'string' && obj.collision) e.collisionUrl = withDir(cfg.collisionDir, obj.collision);
    else e.collisionUrl = cfg.collisionDir + baseName(obj.model).replace(/\.(glb|gltf)$/i, '') + '.json';
    if (obj.rotationY !== undefined) { if (isNum(obj.rotationY)) e.rotationYDeg = obj.rotationY; else warn(`models.json: "${id}".rotationY が数値ではありません`); }
    if (obj.fit && typeof obj.fit === 'object') {
      if (obj.fit.mode === 'scale' && isNum(obj.fit.scale) && obj.fit.scale > 0) { e.fit.mode = 'scale'; e.fit.scale = obj.fit.scale; }
      else if (obj.fit.mode === 'maxDimension' && isNum(obj.fit.size) && obj.fit.size > 0) { e.fit.mode = 'maxDimension'; e.fit.size = obj.fit.size; }
      else if (obj.fit.mode !== undefined) warn(`models.json: "${id}".fit が不正です(mode: maxDimension+size / scale+scale)`);
      if (typeof obj.fit.recenter === 'boolean') e.fit.recenter = obj.fit.recenter;
    }
    if (Array.isArray(obj.offset) && obj.offset.length === 3 && obj.offset.every(isNum)) e.offset = obj.offset;
    else if (obj.offset !== undefined) warn(`models.json: "${id}".offset は [x,y,z] の数値です`);
    if (obj.visualParts && typeof obj.visualParts === 'object') e.visualParts = obj.visualParts;
    return e;
  }
  function conventionEntry(id) {
    return {
      id, modelUrl: cfg.modelDir + id + '.glb', collisionUrl: cfg.collisionDir + id + '.json',
      rotationYDeg: cfg.rotationYDeg, fit: Object.assign({}, cfg.fit), offset: [0, 0, 0], visualParts: null
    };
  }

  function ensureManifest() {
    if (manifestPromise) return manifestPromise;
    let timer = null;
    const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => { if (ctrl) ctrl.abort(); resolve('__timeout__'); }, cfg.manifestTimeoutMs); });
    const job = fetch(cfg.manifestUrl, ctrl ? { signal: ctrl.signal } : undefined).then((res) => {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
    manifestPromise = Promise.race([job, timeout]).then((json) => {
      clearTimeout(timer);
      if (json === '__timeout__') throw new Error('タイムアウト');
      if (!json || typeof json !== 'object' || !json.models || typeof json.models !== 'object') throw new Error('"models" オブジェクトがありません');
      const d = json.defaults || {};
      if (typeof d.modelDir === 'string') cfg.modelDir = d.modelDir;
      if (typeof d.collisionDir === 'string') cfg.collisionDir = d.collisionDir;
      if (isNum(d.rotationY)) cfg.rotationYDeg = d.rotationY;
      if (d.fit && d.fit.mode === 'maxDimension' && isNum(d.fit.size) && d.fit.size > 0) cfg.fit = { mode: 'maxDimension', size: d.fit.size, recenter: d.fit.recenter !== false };
      else if (d.fit && d.fit.mode === 'scale' && isNum(d.fit.scale) && d.fit.scale > 0) cfg.fit = { mode: 'scale', scale: d.fit.scale, recenter: d.fit.recenter !== false };
      for (const id of Object.keys(json.models)) entries.set(id, normalizeEntry(id, json.models[id]));
      manifestOk = true;
    }).catch((e) => {
      clearTimeout(timer);
      warn(`${cfg.manifestUrl} を読み込めませんでした (${e && e.message ? e.message : e})。規約パス(models/<id>.glb)で試行し、失敗した機体は従来の手続き生成モデルを使用します`);
    });
    return manifestPromise;
  }

  // ---------------------------------------------------------------
  // GLB 読み込み
  // ---------------------------------------------------------------
  function loadGlb(url) {
    if (glbCache.has(url)) return glbCache.get(url);
    const p = new Promise((resolve) => {
      if (typeof THREE === 'undefined' || typeof THREE.GLTFLoader !== 'function') {
        warn('THREE.GLTFLoader が利用できません(CDN読込失敗の可能性)。外部モデルは使用せず従来のモデルで続行します');
        resolve(null); return;
      }
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; warn(`${url}: 読み込みタイムアウト(${cfg.glbTimeoutMs}ms)`); resolve(null); } }, cfg.glbTimeoutMs);
      const finish = (v, msg) => { if (done) return; done = true; clearTimeout(timer); if (msg) warn(msg); resolve(v); };
      try {
        if (!gltfLoader) gltfLoader = new THREE.GLTFLoader();
        gltfLoader.load(url,
          (gltf) => finish(gltf && gltf.scene ? gltf.scene : null, gltf && gltf.scene ? null : `${url}: シーンが含まれていません`),
          undefined,
          (err) => finish(null, `${url}: 読み込みに失敗しました (${err && err.message ? err.message : err})`));
      } catch (e) { finish(null, `${url}: ${e && e.message ? e.message : e}`); }
    });
    glbCache.set(url, p);
    return p;
  }

  // 既存の applyAircraftModel と同じ正規化: 回転 → 最大寸法をsizeに拡縮 → バウンディングボックス中心を原点へ
  function computeFit(src, e) {
    const tmp = src.clone(true);
    tmp.rotation.y = e.rotationYDeg * Math.PI / 180;
    tmp.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(tmp);
    if (box.isEmpty()) return null;
    const size = box.getSize(new THREE.Vector3());
    const maxD = Math.max(size.x, size.y, size.z);
    if (!(maxD > 0) || !isFinite(maxD)) return null;
    const scale = e.fit.mode === 'scale' ? e.fit.scale : e.fit.size / maxD;
    tmp.scale.setScalar(scale);
    tmp.updateMatrixWorld(true);
    box.setFromObject(tmp);
    const pos = e.fit.recenter === false ? new THREE.Vector3() : box.getCenter(new THREE.Vector3()).negate();
    pos.x += e.offset[0]; pos.y += e.offset[1]; pos.z += e.offset[2];
    return { rotY: tmp.rotation.y, scale, position: pos };
  }

  // ---------------------------------------------------------------
  // 機体ごとの読み込み（GLB と 当たり判定JSON を並行）
  // ---------------------------------------------------------------
  function load(id) {
    let r = records.get(id);
    if (r) return r.promise;
    r = { phase: 'loading', rec: null, error: null };
    records.set(id, r);
    r.promise = ensureManifest().then(() => {
      const e = entries.get(id) || conventionEntry(id);
      const glbP = loadGlb(e.modelUrl).then((src) => {
        if (!src) return null;
        let fit = null;
        try { fit = computeFit(src, e); } catch (err) { warn(`${e.modelUrl}: サイズ計算に失敗 (${err.message})`); }
        if (!fit) { warn(`${e.modelUrl}: 有効なメッシュ/サイズがありません`); return null; }
        return { id, source: src, fit, entry: e };
      });
      const colP = (NS.collision && e.collisionUrl) ? NS.collision.load(id, e.collisionUrl) : Promise.resolve(false);
      return Promise.all([glbP, colP]).then(([rec]) => {
        r.rec = rec; r.phase = rec ? 'ready' : 'failed';
        if (!rec) r.error = 'model-unavailable';
        return rec;
      });
    }).catch((err) => {
      r.phase = 'failed'; r.error = err && err.message ? err.message : String(err);
      warn(`${id}: ${r.error}`);
      return null;
    });
    return r.promise;
  }

  function createInstance(rec) {
    const m = rec.source.clone(true);
    m.rotation.y = rec.fit.rotY;
    m.scale.setScalar(rec.fit.scale);
    m.position.copy(rec.fit.position);
    m.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    return m;
  }

  /** target(機体メッシュのGroup) の子を外部GLBに差し替える。失敗時は何もしない(従来モデルのまま) */
  function attach(target, id) {
    if (!target || !id) return;
    load(id).then((rec) => {
      if (!rec || !target.parent) return;        // 読み込み失敗 / 既に破棄された機体
      const model = createInstance(rec);
      while (target.children.length) target.remove(target.children[0]);
      target.add(model);
      target.userData.glbModel = model;
      target.userData.extModelId = id;
      // 任意: 部位ノード名を指定すると、翼もげ等の既存演出が外部モデルのノードに対して動く
      const vp = rec.entry.visualParts;
      if (vp) {
        for (const key of Object.keys(vp)) {
          const node = model.getObjectByName(String(vp[key]));
          if (node) target.userData[key] = node; else warn(`${id}: visualParts "${key}" のノード "${vp[key]}" がGLB内に見つかりません`);
        }
      }
    }).catch((e) => warn(`${id}: モデル適用中にエラー (${e && e.message ? e.message : e})`));
  }

  function whenReady(ids, timeoutMs) {
    const list = Array.from(new Set((ids || []).filter(Boolean)));
    const limit = isNum(timeoutMs) ? timeoutMs : cfg.startWaitMs;
    let timer = null;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), limit); });
    const all = Promise.all(list.map((id) => load(id))).then(() => ({ timedOut: false }));
    return Promise.race([all, timeout]).then((res) => {
      clearTimeout(timer);
      const ready = list.filter((id) => records.get(id) && records.get(id).phase === 'ready');
      const failed = list.filter((id) => records.get(id) && records.get(id).phase === 'failed');
      if (res.timedOut) warn(`モデル読込が${limit}ms以内に完了しなかったため、続行します(未完了の機体は読込完了後に自動で差し替わります)`);
      return { timedOut: res.timedOut, ready, failed };
    }, () => ({ timedOut: false, ready: [], failed: list }));
  }

  function prefetch(ids) { (ids || []).forEach((id) => { if (id) load(id); }); }

  function init(opts) {
    if (opts && typeof opts === 'object') {
      if (typeof opts.manifestUrl === 'string') cfg.manifestUrl = opts.manifestUrl;
      if (isNum(opts.startWaitMs)) cfg.startWaitMs = opts.startWaitMs;
      if (isNum(opts.glbTimeoutMs)) cfg.glbTimeoutMs = opts.glbTimeoutMs;
    }
    return ensureManifest();
  }

  function report() {
    const rows = [];
    for (const [id, r] of records) rows.push({ id, phase: r.phase, collision: NS.collision ? (NS.collision.status(id) || {}).state : 'n/a' });
    try { console.table(rows); } catch (e) {}
    return { manifestOk, errors: errors.slice(), rows };
  }

  NS.models = {
    init, attach, load, whenReady, prefetch, report, errors,
    status: (id) => (records.get(id) ? records.get(id).phase : 'idle'),
    isManifestLoaded: () => manifestOk,
    _cfg: cfg, _entries: entries
  };
})(typeof window !== 'undefined' ? window : globalThis);
