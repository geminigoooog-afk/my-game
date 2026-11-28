# 外部モデル読み込み・外部当たり判定 ― 導入メモ

## フォルダ構成（GitHub Pages にそのまま置く）
```
Game/
├── index.html                 ← 変更あり（差分は最小限）
├── js/
│   ├── model-loader.js        ← 新規: GLB読み込み / models.json 管理 / エラー処理
│   └── collision-system.js    ← 新規: JSON当たり判定 (Box/Sphere/Capsule)
├── models/
│   ├── models.json            ← 新規: 機体ID → GLB / 判定JSON の対応表
│   └── *.glb                  ← ★納品済みの62ファイルをここへコピー
├── collision/
│   └── *.json                 ← 新規: 62機分の初期コライダー（概算。要調整）
├── textures/                  ← 現状は未使用（GLBにテクスチャ埋込済み）
├── tools/gen_defaults.py      ← models.json / collision/*.json の初期値生成
└── test/                      ← Node で実行できる単体テスト
```
※ このゲームは航空機のみで、戦車・建物は存在しません。仕組みは機体ID単位で、他種別を足すときも `models.json` に ID を追加するだけです。

## モデルの追加・交換（HTML編集不要）
1. GLB を `models/` に置く（交換なら同名で上書き）
2. `models/models.json` の `models` に1行足す／書き換える
   ```json
   "f15c": { "model": "37_F-15C.glb", "collision": "37_F-15C.json" }
   ```
   - 文字列だけ `"f15c": "37_F-15C.glb"` でも可（判定JSONは `collision/37_F-15C.json` を自動探索）
   - 未記載の機体IDは `models/<id>.glb` と `collision/<id>.json` を規約パスで探します
3. オプション（機体ごと）: `"rotationY": 度`、`"fit": {"mode":"maxDimension","size":11}` または `{"mode":"scale","scale":1.0}`、`"offset":[x,y,z]`、`"collision": null`（判定JSONなし＝従来の球判定）、`"visualParts": {"wingL":"ノード名"}`（翼もげ演出を外部モデルのノードに紐付け）

**既定値は既存コードの挙動を踏襲**しています：最大寸法を11mに正規化し、バウンディングボックス中心を機体原点にします。
ただし `rotationY` は **0** です（旧コードの -90° は旧GLB用。今回の62機は README 記載どおり +Z=機首 でゲーム座標と一致するため）。向きが横を向く場合は `rotationY` を調整してください。

## 当たり判定JSON
座標は **機体ローカル（+Z=機首 / +Y=上 / +X=左翼、原点=モデル中心、11m正規化後のゲーム内m）**。機体の位置・回転・スケール（`mesh.scale`）に追従します。表示モデルとは独立しており、GLBを交換しても判定は変わりません。
```json
{
  "margin": {"player": 1.5, "ai": 3.2, "body": 1.5},
  "colliders": [
    {"id":"fuselage","type":"capsule","target":"fuselage","module":"fuselage",
     "position":[0,0,-0.1],"rotation":[0,0,0],
     "size":{"radius":0.82,"length":10.3,"axis":"z"},"damageMultiplier":1.0,"priority":1},
    {"id":"wingL","type":"box","target":"wingL","module":"wingL",
     "position":[2.2,0,-0.7],"rotation":[0,0,0],"size":{"x":3.0,"y":0.25,"z":2.6},"priority":3},
    {"id":"nose","type":"sphere","target":"nose","module":"radar",
     "position":[0,0,3.6],"size":{"radius":0.8},"priority":3}
  ]
}
```
| 項目 | 内容 |
|---|---|
| `type` | `box`（size: x,y,z=全幅） / `sphere`（size.radius） / `capsule`（size.radius, size.length=両端込み全長, size.axis=x/y/z） |
| `position` / `rotation` | ローカル座標[x,y,z] / 回転[度, XYZオイラー] |
| `target` | 判定対象の名称（任意の文字列） |
| `module` | 被弾時に損傷するゲーム内モジュール。`fuselage wingL wingR tail engine hTail vTail fuelTank radar rwr hud controls ammo`。省略時は `target` が上記に一致すればそれ、違えば `fuselage` |
| `damageMultiplier` | 部位別ダメージ倍率（既定1.0）→ 部位別ダメージ判定の拡張点 |
| `priority` | 部位が重なる箇所でどれを優先するか（大きいほど優先） |
| `enabled` | `false` で無効化 |
| `margin` | 弾の命中判定に足す余裕(m)。`player`=自機が被弾する側／`ai`=AIが被弾する側（既存の 3.5m / 5.2m の差を踏襲）／`body`=機体同士の接触 |

### 判定の使われ方
- **弾**: 前フレーム位置→現在位置の線分で判定（高速弾の貫通も防止）。ダメージ部位は「最初に接触した点」から決定。
- **機体同士の接触**: コライダーを球群に近似して判定。
- **ミサイル**: 近接信管16mの既存ロジックはそのまま。被弾部位のみJSONから決定。
- JSONが無い/不正な機体は、その機体だけ従来の球判定・従来の部位判定で動作します。

### 判定の確認・切替（操作・UIは変更なし。URLパラメータのみ）
- `index.html?colDebug=1` : 全機のコライダーを緑のワイヤーフレームで表示
- `index.html?collision=legacy` : 外部判定を使わず従来の球判定に戻す（バランス比較用）

## エラー処理
| 状況 | 挙動 |
|---|---|
| `models.json` が無い/壊れている | 警告をコンソールへ。規約パスで試行、失敗した機体は従来の手続き生成モデル |
| GLBが無い(404) / 破損 / メッシュ無し / 20秒応答なし | その機体は従来モデルのまま。他機体・ゲームは継続 |
| GLTFLoader のCDN読込失敗 | 従来、起動時に例外で停止し得た箇所。現在は外部モデルを諦めて従来モデルで続行 |
| 判定JSONが無い/壊れている | その機体だけ従来の球判定（モデル表示には影響しない） |
| 判定の一部が不正（型・サイズ・NaN等） | 不正なコライダーだけ無視し、有効分を採用。全滅ならJSON全体を不採用 |
| 読込完了前の出撃 | 出撃ボタンで自機＋同世代のAI候補の読込完了を最大8秒待ってから開始。失敗/超過でも出撃。遅れて届いたモデルは到着次第差し替わる |

警告は `console.warn('[GameExt/...]')`、状況一覧は DevTools で `GameExt.models.report()`。

## 既存コードで見つかり、あわせて直した点
- 再出撃で機種を変えると外部モデルが再適用されず手続きモデルに戻っていた → `applySpec` に再適用を追加
- 旧ローダーはエラーを `catch(()=>{})` で握りつぶし、ファイル名もHTML直書き → `models.json` に移し、警告を出力

## GitHub Pages / Windows での注意
- パスはすべて相対パスです。リポジトリ配下のサブパス公開でも動きます。
- **GitHub Pages は大文字小文字を区別します。** Windowsでは動いても、`models.json` と実ファイル名の大小が違うと本番で404になります。
- ローカル確認は `file://` では `fetch` が使えません。`python -m http.server 8000` → `http://localhost:8000/` で開いてください。
- 更新後に古い内容が出る場合はブラウザのキャッシュ（Pages は約10分キャッシュ）を疑ってください。

## 検証状況（正直に）
- ✅ Node 単体テスト（`node test/test_collision.js` / `test_loader.js` / `test_failures.js <nomanifest|badmanifest|noloader>`）: 判定の回転・スケール追従、各形状、部位判定、不正JSON、貫通防止、各種読込エラー・タイムアウト・フォールバック
- ✅ `index.html` 内スクリプトの構文チェック、改行コード(CRLF)維持、62機のID↔GLB対応が `manifest.csv` と1対1で一致
- ❌ **実ブラウザ + Three.js + 実GLB での表示確認は未実施**（実行環境にブラウザ/GLB本体/CDNが無いため）。納品時チェックリスト参照。
- 初期コライダーは manifest.csv の全長・全幅・全高からの**概算**で、GLBの実形状には合わせていません。`?colDebug=1` で見ながら調整してください。
