/* =====================================================================
 * collision-system.js  -  外部JSON当たり判定システム
 *
 *  - 表示モデル(GLB)とは独立。collision/*.json で Box / Sphere / Capsule を定義
 *  - 判定は「機体(エンティティ)のローカル座標」で定義し、機体の pos / quat / scale に追従
 *  - JSONが無い・不正な機体は null を返し、呼び出し側が従来の球判定にフォールバック
 *  - 計算部は THREE 非依存（デバッグ表示だけ THREE を使う）
 *
 *  座標系(ゲーム準拠): +Z=機首 / +Y=上 / +X=機体の左翼側 / 単位=ゲーム内メートル
 * ===================================================================== */
(function (global) {
  'use strict';
  const NS = global.GameExt = global.GameExt || {};

  const VALID_MODULES = ['fuselage', 'wingL', 'wingR', 'tail', 'engine', 'hTail', 'vTail',
    'fuelTank', 'radar', 'rwr', 'hud', 'controls', 'ammo'];
  const MAX_COLLIDERS = 64;
  const JSON_TIMEOUT_MS = 8000;
  const DEG = Math.PI / 180;

  const defs = new Map();      // aircraft id -> parsed definition
  const status = new Map();    // aircraft id -> { state:'loading'|'ready'|'failed', error? }
  const reported = new Set();
  const cfg = { mode: 'shape' };  // 'shape' | 'legacy'

  function warn(msg, key) {
    const k = key || msg;
    if (reported.has(k)) return;
    reported.add(k);
    try { console.warn('[GameExt/collision] ' + msg); } catch (e) {}
  }

  // ---------------------------------------------------------------
  // 小さな数学ヘルパ（オブジェクト割り当てを避けるため out 引数方式）
  // ---------------------------------------------------------------
  function eulerToQuat(xd, yd, zd) {            // THREE.Euler 'XYZ' と同一
    const x = xd * DEG, y = yd * DEG, z = zd * DEG;
    const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
    const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
    return {
      x: s1 * c2 * c3 + c1 * s2 * s3,
      y: c1 * s2 * c3 - s1 * c2 * s3,
      z: c1 * c2 * s3 + s1 * s2 * c3,
      w: c1 * c2 * c3 - s1 * s2 * s3
    };
  }
  // out = q * v   (invert=true なら q^-1 * v)
  function qRot(q, vx, vy, vz, out, invert) {
    const qx = invert ? -q.x : q.x, qy = invert ? -q.y : q.y, qz = invert ? -q.z : q.z, qw = q.w;
    const ix = qw * vx + qy * vz - qz * vy;
    const iy = qw * vy + qz * vx - qx * vz;
    const iz = qw * vz + qx * vy - qy * vx;
    const iw = -qx * vx - qy * vy - qz * vz;
    out.x = ix * qw + iw * -qx + iy * -qz - iz * -qy;
    out.y = iy * qw + iw * -qy + iz * -qx - ix * -qz;
    out.z = iz * qw + iw * -qz + ix * -qy - iy * -qx;
    return out;
  }
  const _t = { x: 0, y: 0, z: 0 };

  function segPointDistSq(px, py, pz, a, b) {
    const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
    const apx = px - a.x, apy = py - a.y, apz = pz - a.z;
    const l2 = abx * abx + aby * aby + abz * abz;
    let t = l2 > 0 ? (apx * abx + apy * aby + apz * abz) / l2 : 0;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    const dx = apx - abx * t, dy = apy - aby * t, dz = apz - abz * t;
    return dx * dx + dy * dy + dz * dz;
  }
  // 線分(p1,q1) と 線分(p2,q2) の最短距離^2  (Ericson, Real-Time Collision Detection)
  function segSegDistSq(p1, q1, p2, q2) {
    const d1x = q1.x - p1.x, d1y = q1.y - p1.y, d1z = q1.z - p1.z;
    const d2x = q2.x - p2.x, d2y = q2.y - p2.y, d2z = q2.z - p2.z;
    const rx = p1.x - p2.x, ry = p1.y - p2.y, rz = p1.z - p2.z;
    const a = d1x * d1x + d1y * d1y + d1z * d1z;
    const e = d2x * d2x + d2y * d2y + d2z * d2z;
    const f = d2x * rx + d2y * ry + d2z * rz;
    const EPS = 1e-9;
    let s, t;
    if (a <= EPS && e <= EPS) { s = t = 0; }
    else if (a <= EPS) { s = 0; t = Math.min(1, Math.max(0, f / e)); }
    else {
      const c = d1x * rx + d1y * ry + d1z * rz;
      if (e <= EPS) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
      else {
        const b = d1x * d2x + d1y * d2y + d1z * d2z;
        const denom = a * e - b * b;
        s = denom > EPS ? Math.min(1, Math.max(0, (b * f - c * e) / denom)) : 0;
        t = (b * s + f) / e;
        if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
        else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
      }
    }
    const cx = p1.x + d1x * s - (p2.x + d2x * t);
    const cy = p1.y + d1y * s - (p2.y + d2y * t);
    const cz = p1.z + d1z * s - (p2.z + d2z * t);
    return cx * cx + cy * cy + cz * cz;
  }
  // 線分 vs 軸平行ボックス(中心原点, 半径 hx,hy,hz) スラブ法
  function segHitsAabb(a, b, hx, hy, hz) {
    let t0 = 0, t1 = 1;
    const o = [a.x, a.y, a.z], d = [b.x - a.x, b.y - a.y, b.z - a.z], h = [hx, hy, hz];
    for (let i = 0; i < 3; i++) {
      if (Math.abs(d[i]) < 1e-12) { if (o[i] < -h[i] || o[i] > h[i]) return false; }
      else {
        let n1 = (-h[i] - o[i]) / d[i], n2 = (h[i] - o[i]) / d[i];
        if (n1 > n2) { const tmp = n1; n1 = n2; n2 = tmp; }
        if (n1 > t0) t0 = n1;
        if (n2 < t1) t1 = n2;
        if (t0 > t1) return false;
      }
    }
    return true;
  }

  // ---------------------------------------------------------------
  // JSON 検証・パース
  // ---------------------------------------------------------------
  const isNum = (v) => typeof v === 'number' && isFinite(v);
  function vec3(v, def) {
    if (v === undefined) return def;
    if (Array.isArray(v) && v.length === 3 && v.every(isNum)) return { x: v[0], y: v[1], z: v[2] };
    return null;
  }

  function parseCollider(raw, idx, tag) {
    const where = `${tag} colliders[${idx}]`;
    if (!raw || typeof raw !== 'object') { warn(`${where}: オブジェクトではありません。無視します`); return null; }
    if (raw.enabled === false) return null;
    const type = String(raw.type || '').toLowerCase();
    if (type !== 'box' && type !== 'sphere' && type !== 'capsule') {
      warn(`${where}: type が不正です("${raw.type}")。box / sphere / capsule のいずれかにしてください。無視します`); return null;
    }
    const pos = vec3(raw.position, { x: 0, y: 0, z: 0 });
    const rot = vec3(raw.rotation, { x: 0, y: 0, z: 0 });
    if (!pos) { warn(`${where}: position は [x,y,z] の数値3つです。無視します`); return null; }
    if (!rot) { warn(`${where}: rotation は [x,y,z](度) の数値3つです。無視します`); return null; }
    const sz = raw.size;
    if (!sz || typeof sz !== 'object') { warn(`${where}: size がありません。無視します`); return null; }

    const target = raw.target !== undefined ? String(raw.target) : (raw.id !== undefined ? String(raw.id) : 'part' + idx);
    let mod = raw.module !== undefined ? raw.module : target;
    if (!VALID_MODULES.includes(mod)) {
      if (raw.module !== undefined) warn(`${where}: module "${raw.module}" は未定義です(有効: ${VALID_MODULES.join(',')})。fuselage として扱います`);
      mod = 'fuselage';
    }
    const dm = raw.damageMultiplier === undefined ? 1 : raw.damageMultiplier;
    if (!isNum(dm) || dm < 0) { warn(`${where}: damageMultiplier が不正です。無視します`); return null; }
    const pr = raw.priority === undefined ? 0 : raw.priority;

    const c = {
      id: raw.id !== undefined ? String(raw.id) : target,
      type, target, module: mod, damageMultiplier: dm, priority: isNum(pr) ? pr : 0,
      c: pos, q: eulerToQuat(rot.x, rot.y, rot.z), rotDeg: rot,
      r: 0, h: { x: 0, y: 0, z: 0 }, axis: 'z', segHalf: 0, extent: 0, size: sz
    };

    if (type === 'sphere') {
      if (!isNum(sz.radius) || sz.radius <= 0) { warn(`${where}: sphere の size.radius は正の数です。無視します`); return null; }
      c.r = sz.radius; c.extent = sz.radius;
    } else if (type === 'box') {
      if (![sz.x, sz.y, sz.z].every((v) => isNum(v) && v > 0)) { warn(`${where}: box の size は {x,y,z} すべて正の数(全幅)です。無視します`); return null; }
      c.h = { x: sz.x / 2, y: sz.y / 2, z: sz.z / 2 };
      c.extent = Math.hypot(c.h.x, c.h.y, c.h.z);
    } else {
      const axis = sz.axis === undefined ? 'z' : String(sz.axis).toLowerCase();
      if (!isNum(sz.radius) || sz.radius <= 0 || !isNum(sz.length) || sz.length <= 0) { warn(`${where}: capsule の size は {radius, length[, axis]} (正の数)です。無視します`); return null; }
      if (!['x', 'y', 'z'].includes(axis)) { warn(`${where}: capsule の axis は x/y/z です。無視します`); return null; }
      if (sz.length < sz.radius * 2) { warn(`${where}: capsule の length(両端込み全長)は radius*2 以上が必要です。無視します`); return null; }
      c.r = sz.radius; c.axis = axis; c.segHalf = sz.length / 2 - sz.radius; c.extent = sz.length / 2;
    }
    const cl = Math.hypot(pos.x, pos.y, pos.z);
    c.bound = cl + c.extent;
    return c;
  }

  // 機体同士の判定用に、各コライダーを球の集合に近似
  function buildProxySpheres(c) {
    const out = [];
    const toEntity = (lx, ly, lz) => {
      qRot(c.q, lx, ly, lz, _t, false);
      return { x: _t.x + c.c.x, y: _t.y + c.c.y, z: _t.z + c.c.z };
    };
    if (c.type === 'sphere') { const p = toEntity(0, 0, 0); out.push({ x: p.x, y: p.y, z: p.z, r: c.r }); return out; }
    if (c.type === 'capsule') {
      const n = Math.max(1, Math.ceil((c.segHalf * 2) / Math.max(c.r, 0.2)));
      for (let i = 0; i <= n; i++) {
        const s = -c.segHalf + (2 * c.segHalf * i) / n;
        const p = toEntity(c.axis === 'x' ? s : 0, c.axis === 'y' ? s : 0, c.axis === 'z' ? s : 0);
        out.push({ x: p.x, y: p.y, z: p.z, r: c.r });
      }
      return out;
    }
    // box
    let rs = Math.max(Math.min(c.h.x, c.h.y, c.h.z), 0.4);
    const dims = [c.h.x * 2, c.h.y * 2, c.h.z * 2];
    for (let attempt = 0; attempt < 6; attempt++) {
      const cnt = dims.map((d) => Math.max(1, Math.ceil((d - 2 * rs) / (rs * 1.2)) + 1));
      if (cnt[0] * cnt[1] * cnt[2] <= 48) {
        const pts = [];
        for (let i = 0; i < cnt[0]; i++) for (let j = 0; j < cnt[1]; j++) for (let k = 0; k < cnt[2]; k++) {
          const f = (n, m, d) => (m === 1 ? 0 : -(d / 2 - rs) + ((d - 2 * rs) * n) / (m - 1));
          const p = toEntity(f(i, cnt[0], dims[0]), f(j, cnt[1], dims[1]), f(k, cnt[2], dims[2]));
          pts.push({ x: p.x, y: p.y, z: p.z, r: rs });
        }
        return pts;
      }
      rs *= 1.4;
    }
    const p = toEntity(0, 0, 0); out.push({ x: p.x, y: p.y, z: p.z, r: Math.max(c.h.x, c.h.y, c.h.z) });
    return out;
  }

  function parseDefinition(json, tag) {
    if (!json || typeof json !== 'object' || !Array.isArray(json.colliders)) {
      throw new Error('"colliders" 配列がありません');
    }
    if (json.colliders.length === 0) throw new Error('"colliders" が空です');
    if (json.colliders.length > MAX_COLLIDERS) warn(`${tag}: コライダーが多すぎます(最大${MAX_COLLIDERS})。超過分は無視します`);
    const list = [];
    json.colliders.slice(0, MAX_COLLIDERS).forEach((raw, i) => {
      const c = parseCollider(raw, i, tag);
      if (c) list.push(c);
    });
    if (list.length === 0) throw new Error('有効なコライダーが1つもありません');
    const m = json.margin || {};
    const margin = {
      player: isNum(m.player) && m.player >= 0 ? m.player : 0,
      ai: isNum(m.ai) && m.ai >= 0 ? m.ai : 0,
      body: isNum(m.body) && m.body >= 0 ? m.body : 0
    };
    let bound = 0;
    for (const c of list) { c.proxies = buildProxySpheres(c); bound = Math.max(bound, c.bound); }
    return { name: json.name || tag, colliders: list, margin, boundRadius: bound };
  }

  // ---------------------------------------------------------------
  // 読み込み
  // ---------------------------------------------------------------
  function load(id, url) {
    status.set(id, { state: 'loading' });
    if (!url) { status.set(id, { state: 'failed', error: 'no-collision-file' }); return Promise.resolve(false); }
    const fail = (msg) => { status.set(id, { state: 'failed', error: msg }); defs.delete(id); warn(`${id}: ${url} を使用できません (${msg})。従来の球判定にフォールバックします`, 'load:' + id); return false; };
    let timer = null;
    const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => { if (ctrl) ctrl.abort(); resolve('__timeout__'); }, JSON_TIMEOUT_MS); });
    const job = fetch(url, ctrl ? { signal: ctrl.signal } : undefined).then((res) => {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
    return Promise.race([job, timeout]).then((json) => {
      clearTimeout(timer);
      if (json === '__timeout__') return fail('タイムアウト');
      try {
        defs.set(id, parseDefinition(json, id));
        status.set(id, { state: 'ready' });
        return true;
      } catch (e) { return fail(e.message); }
    }).catch((e) => { clearTimeout(timer); return fail(e && e.message ? e.message : String(e)); });
  }

  // 同期で定義を直接登録（テスト・手動設定用）
  function define(id, json) {
    try { defs.set(id, parseDefinition(json, id)); status.set(id, { state: 'ready' }); return true; }
    catch (e) { status.set(id, { state: 'failed', error: e.message }); warn(`${id}: ${e.message}`); return false; }
  }

  // ---------------------------------------------------------------
  // ゲームから呼ばれる判定API（定義なし/legacyモードは null → 従来処理）
  // ---------------------------------------------------------------
  function defOf(ac) {
    if (cfg.mode !== 'shape' || !ac || !ac.spec) return null;
    return defs.get(ac.spec.id) || null;
  }
  function scaleOf(ac) {
    const s = ac.mesh && ac.mesh.scale ? ac.mesh.scale.x : 1;
    return s > 0 && isFinite(s) ? s : 1;
  }

  const _a = { x: 0, y: 0, z: 0 }, _b = { x: 0, y: 0, z: 0 };
  const _ca = { x: 0, y: 0, z: 0 }, _cb = { x: 0, y: 0, z: 0 };
  const _p = { x: 0, y: 0, z: 0 }, _q = { x: 0, y: 0, z: 0 };

  const lastHit = { x: 0, y: 0, z: 0 };     // segmentHit が true を返した直後の「最初の接触点」(ワールド座標)

  // 機体ローカルで、判定(+margin)の内側に最初に入る線分上の点を探す
  function minSd(def, px, py, pz, ml) {
    let m = Infinity;
    for (const c of def.colliders) {
      qRot(c.q, px - c.c.x, py - c.c.y, pz - c.c.z, _cb, true);
      const d = signedDist(c, _cb.x, _cb.y, _cb.z) - ml;
      if (d < m) m = d;
    }
    return m;
  }
  function locateHit(ac, def, s, ml, ax, ay, az, bx, by, bz) {
    const N = 64;
    let firstIn = -1, bestK = 0, bestD = Infinity;
    for (let k = 0; k <= N; k++) {
      const t = k / N;
      const d = minSd(def, ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t, ml);
      if (d < bestD) { bestD = d; bestK = k; }
      if (d <= 0) { firstIn = k; break; }
    }
    let t = (firstIn >= 0 ? firstIn : bestK) / N;
    if (firstIn > 0) {
      let lo = (firstIn - 1) / N, hi = firstIn / N;
      for (let i = 0; i < 8; i++) {
        const mid = (lo + hi) / 2;
        if (minSd(def, ax + (bx - ax) * mid, ay + (by - ay) * mid, az + (bz - az) * mid, ml) <= 0) hi = mid; else lo = mid;
      }
      t = hi;
    }
    qRot(ac.quat, (ax + (bx - ax) * t) * s, (ay + (by - ay) * t) * s, (az + (bz - az) * t) * s, _p, false);
    lastHit.x = ac.pos.x + _p.x; lastHit.y = ac.pos.y + _p.y; lastHit.z = ac.pos.z + _p.z;
  }

  /** 線分(弾の前フレーム位置→現在位置)が機体の判定に当たるか。判定未定義なら null。
   *  当たった場合は lastHit に最初の接触点が入る */
  function segmentHit(ac, a, b) {
    const def = defOf(ac); if (!def) return null;
    const s = scaleOf(ac);
    const m = (ac.isPlayer ? def.margin.player : def.margin.ai);
    // 粗判定(ワールド座標)
    const bound = def.boundRadius * s + m;
    if (segPointDistSq(ac.pos.x, ac.pos.y, ac.pos.z, a, b) > bound * bound) return false;
    // 機体ローカルへ
    qRot(ac.quat, a.x - ac.pos.x, a.y - ac.pos.y, a.z - ac.pos.z, _a, true);
    qRot(ac.quat, b.x - ac.pos.x, b.y - ac.pos.y, b.z - ac.pos.z, _b, true);
    _a.x /= s; _a.y /= s; _a.z /= s; _b.x /= s; _b.y /= s; _b.z /= s;
    const ml = m / s;
    const ax = _a.x, ay = _a.y, az = _a.z, bx = _b.x, by = _b.y, bz = _b.z;
    let hit = false;
    for (const c of def.colliders) {
      // コライダー座標系へ
      qRot(c.q, _a.x - c.c.x, _a.y - c.c.y, _a.z - c.c.z, _ca, true);
      qRot(c.q, _b.x - c.c.x, _b.y - c.c.y, _b.z - c.c.z, _cb, true);
      if (c.type === 'sphere') {
        const rr = c.r + ml;
        if (segPointDistSq(0, 0, 0, _ca, _cb) <= rr * rr) { hit = true; break; }
      } else if (c.type === 'capsule') {
        _p.x = _p.y = _p.z = 0; _q.x = _q.y = _q.z = 0;
        _p[c.axis] = -c.segHalf; _q[c.axis] = c.segHalf;
        const rr = c.r + ml;
        if (segSegDistSq(_ca, _cb, _p, _q) <= rr * rr) { hit = true; break; }
      } else if (segHitsAabb(_ca, _cb, c.h.x + ml, c.h.y + ml, c.h.z + ml)) { hit = true; break; }
    }
    if (hit) locateHit(ac, def, s, ml, ax, ay, az, bx, by, bz);
    return hit;
  }

  /** 機体同士の接触。どちらかが判定未定義なら null */
  function bodyOverlap(A, B) {
    const dA = defOf(A), dB = defOf(B); if (!dA || !dB) return null;
    const sA = scaleOf(A), sB = scaleOf(B);
    const mm = dA.margin.body + dB.margin.body;
    const dx = A.pos.x - B.pos.x, dy = A.pos.y - B.pos.y, dz = A.pos.z - B.pos.z;
    const lim = dA.boundRadius * sA + dB.boundRadius * sB + mm;
    if (dx * dx + dy * dy + dz * dz > lim * lim) return false;
    const wa = [], wb = [];
    for (const c of dA.colliders) for (const p of c.proxies) {
      qRot(A.quat, p.x * sA, p.y * sA, p.z * sA, _ca, false);
      wa.push(A.pos.x + _ca.x, A.pos.y + _ca.y, A.pos.z + _ca.z, p.r * sA);
    }
    for (const c of dB.colliders) for (const p of c.proxies) {
      qRot(B.quat, p.x * sB, p.y * sB, p.z * sB, _cb, false);
      wb.push(B.pos.x + _cb.x, B.pos.y + _cb.y, B.pos.z + _cb.z, p.r * sB);
    }
    for (let i = 0; i < wa.length; i += 4) for (let j = 0; j < wb.length; j += 4) {
      const ex = wa[i] - wb[j], ey = wa[i + 1] - wb[j + 1], ez = wa[i + 2] - wb[j + 2];
      const rr = wa[i + 3] + wb[j + 3] + mm;
      if (ex * ex + ey * ey + ez * ez <= rr * rr) return true;
    }
    return false;
  }

  function signedDist(c, px, py, pz) {   // コライダー座標系での符号付き距離
    if (c.type === 'sphere') return Math.hypot(px, py, pz) - c.r;
    if (c.type === 'capsule') {
      const v = c.axis === 'x' ? px : (c.axis === 'y' ? py : pz);
      const t = Math.max(-c.segHalf, Math.min(c.segHalf, v));
      const dx = c.axis === 'x' ? px - t : px, dy = c.axis === 'y' ? py - t : py, dz = c.axis === 'z' ? pz - t : pz;
      return Math.hypot(dx, dy, dz) - c.r;
    }
    const qx = Math.abs(px) - c.h.x, qy = Math.abs(py) - c.h.y, qz = Math.abs(pz) - c.h.z;
    const out = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0));
    return out + Math.min(Math.max(qx, qy, qz), 0);
  }

  /** ワールド座標 worldPos に最も対応する判定部位。未定義なら null */
  function partAt(ac, worldPos) {
    const def = defOf(ac); if (!def || !worldPos) return null;
    const s = scaleOf(ac);
    qRot(ac.quat, worldPos.x - ac.pos.x, worldPos.y - ac.pos.y, worldPos.z - ac.pos.z, _a, true);
    _a.x /= s; _a.y /= s; _a.z /= s;
    let best = null, bestD = Infinity, bestInside = false;
    for (const c of def.colliders) {
      qRot(c.q, _a.x - c.c.x, _a.y - c.c.y, _a.z - c.c.z, _ca, true);
      const d = signedDist(c, _ca.x, _ca.y, _ca.z);
      const inside = d <= 0;
      let better;
      if (!best) better = true;
      else if (inside !== bestInside) better = inside;
      else if (inside) better = c.priority > best.priority || (c.priority === best.priority && d < bestD);
      else better = d < bestD - 1e-9 || (Math.abs(d - bestD) <= 1e-9 && c.priority > best.priority);
      if (better) { best = c; bestD = d; bestInside = inside; }
    }
    return best ? { module: best.module, damageMultiplier: best.damageMultiplier, target: best.target, colliderId: best.id } : null;
  }

  // ---------------------------------------------------------------
  // デバッグ表示 (URL に ?colDebug=1 を付けた時だけ有効。操作/UIは変更しない)
  // ---------------------------------------------------------------
  const dbg = { on: false, scene: null, groups: new Map() };
  function buildDebugGroup(def) {
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: 0x00ff66, wireframe: true, transparent: true, opacity: 0.55, depthTest: false });
    for (const c of def.colliders) {
      const node = new THREE.Group();
      node.position.set(c.c.x, c.c.y, c.c.z);
      node.rotation.set(c.rotDeg.x * DEG, c.rotDeg.y * DEG, c.rotDeg.z * DEG, 'XYZ');
      if (c.type === 'sphere') node.add(new THREE.Mesh(new THREE.SphereGeometry(c.r, 12, 8), mat));
      else if (c.type === 'box') node.add(new THREE.Mesh(new THREE.BoxGeometry(c.h.x * 2, c.h.y * 2, c.h.z * 2), mat));
      else {
        const cap = new THREE.Group();
        cap.add(new THREE.Mesh(new THREE.CylinderGeometry(c.r, c.r, c.segHalf * 2, 12, 1, true), mat));
        const s1 = new THREE.Mesh(new THREE.SphereGeometry(c.r, 12, 6), mat); s1.position.y = c.segHalf;
        const s2 = new THREE.Mesh(new THREE.SphereGeometry(c.r, 12, 6), mat); s2.position.y = -c.segHalf;
        cap.add(s1, s2);
        if (c.axis === 'z') cap.rotation.x = Math.PI / 2; else if (c.axis === 'x') cap.rotation.z = Math.PI / 2;
        node.add(cap);
      }
      g.add(node);
    }
    g.traverse((o) => { o.renderOrder = 999; });
    return g;
  }
  function debugUpdate(aircrafts) {
    if (!dbg.on || !dbg.scene || typeof THREE === 'undefined') return;
    const seen = new Set();
    for (const ac of aircrafts) {
      const def = defOf(ac); if (!def || !ac.alive) continue;
      seen.add(ac);
      let g = dbg.groups.get(ac);
      if (!g || g.userData.def !== def) {
        if (g) dbg.scene.remove(g);
        g = buildDebugGroup(def); g.userData.def = def; dbg.scene.add(g); dbg.groups.set(ac, g);
      }
      g.position.copy(ac.pos); g.quaternion.copy(ac.quat); g.scale.setScalar(scaleOf(ac));
    }
    for (const [ac, g] of dbg.groups) if (!seen.has(ac)) { dbg.scene.remove(g); dbg.groups.delete(ac); }
  }
  function enableDebug(scene) { dbg.on = true; dbg.scene = scene; }

  // URL パラメータ
  try {
    const q = new URLSearchParams(global.location ? global.location.search : '');
    if (q.get('collision') === 'legacy') cfg.mode = 'legacy';
  } catch (e) {}

  NS.collision = {
    VALID_MODULES, load, define, parseDefinition, has: (id) => defs.has(id), get: (id) => defs.get(id),
    status: (id) => status.get(id) || null,
    segmentHit, bodyOverlap, partAt, lastHit,
    setMode(m) { cfg.mode = (m === 'legacy') ? 'legacy' : 'shape'; },
    getMode: () => cfg.mode,
    enableDebug, debugUpdate,
    _math: { segSegDistSq, segHitsAabb, segPointDistSq, eulerToQuat, qRot, signedDist }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = NS.collision;
})(typeof window !== 'undefined' ? window : globalThis);
