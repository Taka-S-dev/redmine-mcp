# redmine-mcp ツール仕様

このサーバーが提供する 6 つの MCP ツールの詳細仕様。**ソース** `src/tools/*.ts` **が一次情報**で、このドキュメントは人間向けの要約。仕様変更があったら再生成する。

## 目次

| ツール | 用途 | ソース |
|---|---|---|
| [search_issues](#search_issues) | チケットを条件で厳密に検索 | [src/tools/search-issues.ts](../src/tools/search-issues.ts) |
| [quick_search](#quick_search) | 曖昧キーワードで全文検索 | [src/tools/quick-search.ts](../src/tools/quick-search.ts) |
| [get_issue](#get_issue) | チケット 1 件の詳細＋履歴 | [src/tools/get-issue.ts](../src/tools/get-issue.ts) |
| [export_issues_csv](#export_issues_csv) | チケットを CSV エクスポート | [src/tools/export-issues-csv.ts](../src/tools/export-issues-csv.ts) |
| [list_time_entries](#list_time_entries) | 工数取得・集計（親子対応） | [src/tools/list-time-entries.ts](../src/tools/list-time-entries.ts) |
| [aggregate_issues](#aggregate_issues) | クロス集計（トークン節約） | [src/tools/aggregate-issues.ts](../src/tools/aggregate-issues.ts) |
| [list_projects](#list_projects) | プロジェクト一覧 | [src/tools/list-projects.ts](../src/tools/list-projects.ts) |
| [list_custom_fields](#list_custom_fields) | カスタムフィールド一覧 | [src/tools/list-custom-fields.ts](../src/tools/list-custom-fields.ts) |
| [describe_schema](#describe_schema) | スキーマ全体を一括取得 | [src/tools/describe-schema.ts](../src/tools/describe-schema.ts) |
| [refresh_metadata](#refresh_metadata) | メタ情報キャッシュ再取得 | [src/tools/refresh-metadata.ts](../src/tools/refresh-metadata.ts) |

---

## 共通の設計方針

- **読み取り専用**: 書き込み系（チケット作成・更新・削除）は実装しない
- **名前で指定可能**: プロジェクト・トラッカー・ステータス・カスタムフィールドは **日本語名で OK**（内部で ID に解決）
- **メタ情報はキャッシュ**: 起動時に 1 回取得、必要なら `refresh_metadata` で再取得
- **エラーは構造化**: 不明な値を指定したら「利用可能な値の一覧」が返る

---

## プロジェクトスコープ（厳格モード）

`.env` に `REDMINE_PROJECTS=foo,bar,baz` を設定すると、以下が有効になる：

| 効果 | 詳細 |
|---|---|
| **可視性フィルタ** | `describe_schema` / `list_projects` はスコープ内のみ表示 |
| **厳格モード** | スコープ外プロジェクトを `project` 引数に指定するとエラー（綴りミスや他チーム侵入を防ぐ） |
| **fan-out デフォルト** | `project` 省略時、スコープ内**全プロジェクトに並列問い合わせ**しマージ |
| **自動クリーンアップ** | スコープに含めた identifier が Redmine に存在しないものは自動的に除外（404 にならない） |

会社の大量プロジェクト下で「自分の担当プロジェクト群だけ集計したい」用途に最適。

詳細は [../README.md](../README.md) の「.env を作成」セクション参照。

---

## search_issues

### 何をするか

Redmine のチケットを柔軟な条件で検索する。**最も使うツール**。

- 未完了チケット一覧
- 特定機能のバグ一覧
- 先週更新されたもの
- 担当者別・期間別の絞り込み

結果は要約情報のみ。詳細が必要なチケットは `get_issue` で深掘りする。

### 引数

| 名前 | 型 | 必須 | デフォルト | 説明 |
|---|---|---|---|---|
| `project` | string | — | 全プロジェクト | プロジェクト名 or identifier。例: `"testredmine"`, `"TestRedmine"` |
| `status` | string | — | `"open"` | `"open"` / `"closed"` / `"all"`(`"*"`) または個別ステータス名（`"完了"` `"作成"` 等） |
| `assigned_to` | string | — | 全担当者 | `"me"`(自分) / `"none"`(未割当) / ユーザー名 / 数値 ID |
| `tracker` | string | — | 全トラッカー | トラッカー名。例: `"バグ"`, `"議事録"` |
| `subject_contains` | string | — | — | 件名に含まれる文字列で絞り込み（部分一致） |
| `description_contains` | string | — | — | 説明文（本文）に含まれる文字列で絞り込み（部分一致） |
| `notes_contains` | string | — | — | コメント（journals）に含まれる文字列で絞り込み（部分一致） |
| `created_after` | string (YYYY-MM-DD) | — | — | 作成日がこの日付以降 |
| `created_before` | string (YYYY-MM-DD) | — | — | 作成日がこの日付以前 |
| `updated_after` | string (YYYY-MM-DD) | — | — | 更新日がこの日付以降 |
| `updated_before` | string (YYYY-MM-DD) | — | — | 更新日がこの日付以前 |
| `custom_fields` | object<string, string> | — | — | フィールド名→値 のマップ。例: `{"カテゴリ": "ログイン"}` |
| `custom_field_match` | `"exact"` \| `"partial"` | — | `"exact"` | CF 値のマッチング。`partial` で部分一致（`"ログイン"` が `"ログイン画面"` 等にもヒット） |
| `due_after` | string (YYYY-MM-DD) | — | — | 期日がこの日付以降 |
| `due_before` | string (YYYY-MM-DD) | — | — | 期日がこの日付以前 |
| `overdue` | boolean | — | — | true で「期限切れ × 未完了」だけ抽出。status=open に強制、due_before を今日に設定 |
| `parent_id` | integer | — | — | 親チケット ID。配下の子チケットだけ返す（バグの修正タスク列挙等） |
| `sort` | string | — | `"updated_on:desc"` | Redmine の sort 記法。例: `"spent_hours:desc"`, `"due_date:asc"`, 複合: `"priority:desc,due_date:asc"` |
| `limit` | integer (1–500) | — | `50` | 取得件数の上限 |
| `count_only` | boolean | — | — | true で `issues` を返さず `total_count` だけ返す。**トークン節約** |

### 返却値

```jsonc
{
  "total_count": 57,                    // 条件にマッチした全件数（limit より多い場合あり）
  "returned": 5,                        // 実際に返した件数
  "query": { ... },                     // Redmine に投げた生のクエリパラメータ（デバッグ用）
  "issues": [
    {
      "id": 55,
      "url": "http://localhost:3000/issues/55",       // ブラウザで開けるリンク（REDMINE_URL から自動生成）
      "subject": "議事録 2026-06-03 API設計 #48",
      "project": "TestRedmine",
      "tracker": "議事録",
      "status": "完了",
      "priority": "低カスタム",
      "parent_id": null,                 // 親チケットの ID。null なら親（トップレベル）、値があれば子チケット
      "assigned_to": "山田太郎",         // 未割当ならフィールド自体なし
      "author": "佐藤花子",
      "done_ratio": 100,
      "estimated_hours": 16,             // 見積もり工数（未設定なら null）
      "spent_hours": 24.5,               // 実工数（未設定なら null）
      "start_date": "2026-06-03",
      "due_date": "2026-06-08",
      "created_on": "2026-05-19T13:26:22Z",
      "updated_on": "2026-05-19T13:26:22Z",
      "closed_on": null,                 // is_closed=true のステータスにしないと埋まらない
      "custom_fields": [                 // 設定されている CF のみ
        { "name": "カテゴリ", "value": "ログイン" }
      ]
    }
  ],
  "hint": "57 件中 5 件を返却。limit を増やすか条件を絞り込んでください。"  // 切り詰めたときのみ
}
```

### 特殊な挙動

- **`status` 省略時は `"open"`**: Redmine の挙動と同じ。`is_closed=false` のステータスを全部含む（「完了」が `is_closed=false` 設定だと完了も含まれてしまう点に注意）
- **`assigned_to` の名前解決**: ユーザー一覧 API（管理者権限が必要なケースあり）で `login` / 姓名 / 部分一致を順に試す。失敗したら Redmine に文字列のまま渡す
- **カスタムフィールド名は大文字小文字を区別しない**: `"カテゴリ"` と `"カテゴリ "`（末尾空白）は trim される
- **CF 値は既定で完全一致**。`custom_field_match: "partial"` で部分一致：
  - **リスト型 CF**（選択肢あり）: Redmine の `~` 演算子はリスト型に効かないため、
    選択肢の中から入力文字列を含むものを探し、その完全な値に自動変換する。
    例: `カテゴリ="ログイン"` → 選択肢 `ログイン機能` に解決。
    複数候補にマッチ／該当なしの場合は候補を提示するエラーになる。
  - **文字列・テキスト型 CF**: Redmine の `~`（部分一致）演算子をそのまま使う。
- **日付範囲は `><` 記法**: `created_after` と `created_before` 両方指定すると `created_on=><YYYY-MM-DD|YYYY-MM-DD` に変換

### よく使うクエリ例

```
未完了チケットを担当者別にカウント
→ search_issues({ project: "testredmine", status: "open", limit: 500 })
→ 結果を assigned_to で group by

カテゴリが「ログイン」のバグ
→ search_issues({ tracker: "バグ", custom_fields: { "カテゴリ": "ログイン" } })

先週更新されたチケット
→ search_issues({ updated_after: "2026-05-12", updated_before: "2026-05-18" })

期限切れの未完了
→ search_issues({ status: "open" })
→ 結果から due_date < today のものを抽出
```

---

## quick_search

### 何をするか

Redmine の**全文検索 API**（`/search.json`）を使い、キーワードで件名・本文・コメントを横断検索する。

`search_issues` との使い分け：

| | quick_search | search_issues |
|---|---|---|
| 向き | **曖昧なキーワード検索** | 厳密な条件指定 |
| マッチ | スペース区切りで**単語単位**（柔軟） | フィールド指定の部分／完全一致 |
| 例 | 「ログイン まわりのチケット」 | 「ステータス=進行中 かつ 担当=自分」 |

`search_issues` で「完全一致じゃないと出てこない」ときは `quick_search` を使う。

### 引数

| 名前 | 型 | 必須 | デフォルト | 説明 |
|---|---|---|---|---|
| `query` | string | ✓ | — | 検索キーワード。スペース区切りで複数語指定可 |
| `project` | string | — | スコープ依存 | プロジェクト名 or identifier で限定 |
| `open_only` | boolean | — | `false` | true で未完了チケットのみ |
| `limit` | integer (1–200) | — | `50` | 取得件数の上限 |

### 返却値

```jsonc
{
  "query": "ログイン エラー",
  "total_count": 12,
  "returned": 12,
  "results": [
    {
      "id": 142,
      "title": "Bug #142 (進行中): ログイン画面でエラー",
      "url": "http://localhost:3000/issues/142",
      "snippet": "ログイン時に 500 エラーが発生する……",
      "datetime": "2026-05-19T13:26:22Z"
    }
  ],
  "hint": "..."
}
```

結果は概要のみ。詳細は `get_issue`、条件で厳密に絞るなら `search_issues`。

### よく使うクエリ例

```
ログイン関連のチケットをざっくり探したい
→ quick_search({ query: "ログイン" })

決済まわりのエラーを横断検索
→ quick_search({ query: "決済 エラー" })

「再現」というキーワードを含む未完了チケット
→ quick_search({ query: "再現", open_only: true })
```

---

## get_issue

### 何をするか

チケット 1 件の詳細を取得する。コメント履歴（journals）、関連チケット、子チケット、添付ファイルを含む。

**バグの原因分析**に使う想定。`description` と `journals` を読んで LLM が分析する。

### 引数

| 名前 | 型 | 必須 | デフォルト | 説明 |
|---|---|---|---|---|
| `id` | integer (>0) | ✓ | — | チケット ID |
| `include` | array of enum | — | `["journals", "relations", "children", "attachments"]` | 追加情報の取得対象 |

`include` で指定できる値：

| 値 | 内容 |
|---|---|
| `journals` | コメント・変更履歴（**バグ分析で最重要**） |
| `relations` | 関連チケット（重複・先行関係など） |
| `children` | 子チケット |
| `attachments` | 添付ファイル |
| `changesets` | 関連コミット（リポジトリ連携時） |
| `watchers` | ウォッチャー一覧 |

### 返却値

Redmine の `/issues/{id}.json` レスポンスを**ほぼそのまま**返す（型は [src/types.ts:RedmineIssue](../src/types.ts) 参照）。代表的なフィールド：

```jsonc
{
  "url": "http://localhost:3000/issues/3",
  "id": 3,
  "subject": "議事録 2026-05-01 設計レビュー",
  "description": "初回設計レビューの議事録",
  "project": { "id": 1, "name": "TestRedmine" },
  "tracker": { "id": 1, "name": "議事録" },
  "status": { "id": 3, "name": "完了" },
  "priority": { "id": 1, "name": "高カスタム" },
  "author": { "id": 1, "name": "..." },
  "assigned_to": { "id": 1, "name": "..." },
  "done_ratio": 100,
  "start_date": "2026-05-01",
  "due_date": "2026-05-08",
  "created_on": "2026-05-19T13:23:55Z",
  "updated_on": "2026-05-19T13:24:18Z",
  "journals": [
    {
      "id": 1,
      "user": { "id": 1, "name": "..." },
      "notes": "レビュー指摘事項を反映",
      "created_on": "2026-05-19T13:24:18Z",
      "details": [
        { "property": "attr", "name": "status_id", "old_value": "1", "new_value": "3" }
      ]
    }
  ],
  "relations": [
    { "id": 1, "issue_id": 3, "issue_to_id": 5, "relation_type": "relates" }
  ]
}
```

### よく使うクエリ例

```
#42 のバグ原因を分析して
→ get_issue({ id: 42 })  // journals 込みで取得 → LLM が description と notes を読んで分析

#100 の修正履歴を時系列で見たい
→ get_issue({ id: 100, include: ["journals"] })

#5 に関連するチケットを全部教えて
→ get_issue({ id: 5, include: ["relations", "children"] })
```

---

## export_issues_csv

### 何をするか

チケットを検索し、結果を **CSV ファイル**として `exports/` ディレクトリに保存する。

**CSV はサーバー側（MCP）で生成する**ため、LLM が行データを 1 文字も生成しない。
→ 「LLM に表を全部書かせる」方式より**圧倒的に速く、トークン消費も小さい**。

Excel で文字化けしないよう **UTF-8 BOM 付き・CRLF 改行**で出力する。

### 引数

#### 絞り込み（search_issues とほぼ同じ）

`project` / `status` / `assigned_to` / `tracker` / `subject_contains` / `description_contains` /
`notes_contains` / `created_after,before` / `updated_after,before` / `due_after,before` /
`overdue` / `custom_fields` / `custom_field_match` / `parent_id` / `sort`

| 名前 | 型 | デフォルト | 説明 |
|---|---|---|---|
| `limit` | integer (1–5000) | `1000` | 出力する最大件数 |

#### 出力オプション

| 名前 | 型 | デフォルト | 説明 |
|---|---|---|---|
| `fields` | string[] | 標準セット | 出力する列。指定順に並ぶ |
| `filename` | string | `issues_<日時>.csv` | 出力ファイル名（`exports/` 配下に保存） |

**`fields` で指定できる列：**
- 標準列: `id` `url` `subject` `project` `tracker` `status` `priority` `parent_id` `assigned_to` `author` `done_ratio` `estimated_hours` `spent_hours` `start_date` `due_date` `created_on` `updated_on` `closed_on` `description`
- カスタムフィールド: `cf:<フィールド名>`（例: `cf:カテゴリ`）

### 返却値

```jsonc
{
  "saved": true,
  "csv_path": "C:\\...\\Redmine\\exports\\issues_2026-05-20-09-30-00.csv",
  "relative_path": "exports/issues_2026-05-20-09-30-00.csv",
  "row_count": 132,
  "total_matched": 132,
  "truncated": false,           // limit で切り捨てられたか
  "columns": ["id", "subject", "status", ...],
  "preview": [ ["1", "...", "..."], ... ],   // 先頭 3 行だけ
  "note": "132 件を CSV 出力しました。Excel で開けます（UTF-8 BOM 付き）。"
}
```

### よく使うクエリ例

```
未完了チケットを CSV にして
→ export_issues_csv({ status: "open" })

期限切れチケットを、ID・件名・担当者・期日・カテゴリ の列で CSV に
→ export_issues_csv({
    overdue: true,
    fields: ["id", "subject", "assigned_to", "due_date", "cf:カテゴリ"],
    filename: "overdue.csv"
  })

完了チケットを工数列込みでエクスポート
→ export_issues_csv({
    status: "closed",
    fields: ["id", "subject", "estimated_hours", "spent_hours", "assigned_to"]
  })
```

### 注意

- 出力先 `exports/` は `.gitignore` で**追跡対象外**（業務データの誤コミット防止）
- `filename` のパス区切り文字・禁止文字は自動的に `_` に置換される
- `.csv` 拡張子は自動付与される

---

## list_time_entries

### 何をするか

工数（time entries）を取得・集計する。**親チケットの子全件分を一括集計**できるのが目玉。「バグ #500 の修正に何時間かかった？誰が？」が 1 ツール呼び出しで答えられる。

### 引数

| 名前 | 型 | 必須 | デフォルト | 説明 |
|---|---|---|---|---|
| `issue_id` | integer | — | — | 特定チケットの工数だけ取得 |
| `parent_issue_id` | integer | — | — | **親チケット ID**。配下の子全件の工数を一括集計 |
| `project` | string | — | — | プロジェクト名 or identifier |
| `user` | string | — | — | `"me"`（自分）または数値ユーザー ID |
| `activity` | string | — | — | 作業分類名（例: `"実装"`, `"テスト"`）または ID |
| `spent_after` | string (YYYY-MM-DD) | — | — | 作業日がこの日付以降 |
| `spent_before` | string (YYYY-MM-DD) | — | — | 作業日がこの日付以前 |
| `limit` | integer (1–1000) | — | `200` | 取得件数の上限 |
| `return_entries` | boolean | — | `true` | false にすると集計だけ返す（**トークン節約**） |
| `export_csv` | boolean | — | `false` | true で工数エントリを CSV ファイル化（`exports/` に保存） |
| `filename` | string | — | 自動 | CSV のファイル名（`export_csv=true` 時） |

### 返却値

```jsonc
{
  "parent_issue_id": 500,
  "total_count": 12,           // エントリ数
  "total_hours": 24.5,         // 工数合計
  "by_user": {
    "山田 太郎": 12,
    "佐藤 花子": 12.5
  },
  "by_issue": {
    "501": 5,
    "502": 19.5
  },
  "by_activity": {
    "実装": 18,
    "テスト": 6.5
  },
  "entries": [                  // return_entries=false なら省略
    { "id": 1, "hours": 2.5, "user": "山田 太郎", "issue_id": 501,
      "issue_url": "http://localhost:3000/issues/501",
      "activity": "実装", "spent_on": "2026-05-12", "comments": "..." }
  ]
}
```

### よく使うクエリ例

```
親チケット #500 配下の総工数と内訳
→ list_time_entries({ parent_issue_id: 500 })

先月のカテゴリ別工数（自分の分）
→ list_time_entries({ user: "me", spent_after: "2026-04-01", spent_before: "2026-04-30" })

実装作業の工数（過去 30 日）
→ list_time_entries({ activity: "実装", spent_after: "2026-04-20" })
```

---

## aggregate_issues

### 何をするか

チケットを **MCP サーバー側で集計** する。`search_issues` で 500 件取って LLM 側で group by すると **トークン浪費 + 精度ブレ** が起きるが、これを使えば集計結果だけが返るので **数十倍トークン効率がいい**。クロス集計（複数軸）対応。

### 引数

#### フィルタ（search_issues とほぼ同じ）

| 名前 | 型 | 説明 |
|---|---|---|
| `project` | string | プロジェクト |
| `status` | string | `"open"` / `"closed"` / `"all"` / ステータス名。省略時 `"open"` |
| `assigned_to` | string | 担当者 |
| `tracker` | string | トラッカー |
| `subject_contains` | string | 件名部分一致 |
| `created_after/before` | YYYY-MM-DD | 作成日範囲 |
| `updated_after/before` | YYYY-MM-DD | 更新日範囲 |
| `due_after/before` | YYYY-MM-DD | 期日範囲 |
| `overdue` | boolean | 期限切れだけ |
| `custom_fields` | object | カスタムフィールド絞り込み |
| `parent_id` | integer | 親チケットの子だけ集計 |

#### 集計指定

| 名前 | 型 | 必須 | デフォルト | 説明 |
|---|---|---|---|---|
| `group_by` | string[] | ✓ | — | 集計軸（**複数指定可、クロス集計**）。標準キー: `"assignee"` / `"author"` / `"status"` / `"tracker"` / `"priority"` / `"project"`。カスタムフィールドは `"cf:<フィールド名>"`（例: `"cf:カテゴリ"`） |
| `metrics` | string[] | — | `["count"]` | 計算対象。選択肢: `"count"` / `"sum_estimated_hours"` / `"sum_spent_hours"` / `"avg_done_ratio"` |
| `sort_by` | string | — | `"count:desc"` | メトリクス名で並び順指定。例: `"sum_spent_hours:desc"` |
| `top` | integer (1–100) | — | — | 上位 N グループだけ返す（TOP10 とか） |
| `fetch_limit` | integer (1–500) | — | `500` | 集計のために取得する最大チケット数 |
| `export_csv` | boolean | — | `false` | true で集計結果（groups）を CSV ファイル化（`exports/` に保存） |
| `filename` | string | — | 自動 | CSV のファイル名（`export_csv=true` 時） |

### 返却値

```jsonc
{
  "source": {
    "total_matched": 57,         // フィルタにヒットした全件数
    "fetched": 57,               // 実際に集計に使った件数
    "truncated": false,          // fetch_limit で切り捨てられたか
    "query": { ... }
  },
  "group_by": ["カテゴリ"],
  "metrics": ["count", "sum_spent_hours"],
  "sort_by": "sum_spent_hours:desc",
  "group_count": 4,
  "groups": [
    { "カテゴリ": "決済",   "count": 5, "sum_spent_hours": 90 },
    { "カテゴリ": "ログイン", "count": 8, "sum_spent_hours": 56 },
    { "カテゴリ": "通知",   "count": 3, "sum_spent_hours": 12 }
  ]
}
```

### よく使うクエリ例

```
担当者別の未完了件数（多い順）
→ aggregate_issues({ group_by: ["assignee"], sort_by: "count:desc" })

カテゴリ × 優先度のクロス集計
→ aggregate_issues({
    group_by: ["cf:カテゴリ", "priority"],
    metrics: ["count"]
  })

工数オーバーカテゴリ TOP5
→ aggregate_issues({
    tracker: "バグ",
    group_by: ["cf:カテゴリ"],
    metrics: ["sum_estimated_hours", "sum_spent_hours"],
    sort_by: "sum_spent_hours:desc",
    top: 5
  })

期限切れチケットを起票者別に
→ aggregate_issues({
    overdue: true,
    group_by: ["author"],
    sort_by: "count:desc"
  })
```

---

## list_projects

### 何をするか

Redmine のプロジェクト一覧を返す。`search_issues` の `project` 引数に何を渡せるか確認するのに使う。

### 引数

なし。

### 返却値

```jsonc
{
  "count": 1,
  "fetched_at": "2026-05-19T14:00:00.000Z",
  "projects": [
    {
      "id": 1,
      "identifier": "testredmine",     // search_issues に渡すのはこれが推奨
      "name": "TestRedmine",            // これでも search_issues は受け付ける
      "parent": "親プロジェクト名",      // ある場合
      "description": "..."              // 200 文字で切り詰め
    }
  ]
}
```

### 注意

- 結果はキャッシュから返る（`refresh_metadata` で再取得）
- 最大 500 件まで（普通の Redmine インスタンスならこれで足りる）

---

## list_custom_fields

### 何をするか

カスタムフィールド定義の一覧を返す。`search_issues` の `custom_fields` パラメータで使えるフィールド名と、選択肢型なら `possible_values` も取れる。

> **管理者権限が必要**。一般ユーザーの API キーだとこのツールはエラーになる（他のツールは動く）。

### 引数

なし。

### 返却値

```jsonc
{
  "count": 3,
  "fetched_at": "2026-05-19T14:00:00.000Z",
  "custom_fields": [
    {
      "id": 5,
      "name": "カテゴリ",
      "field_format": "list",            // string / int / bool / date / list / etc.
      "customized_type": "issue",
      "is_required": false,
      "is_filter": true,                  // false だと検索フィルタとして使えない
      "multiple": false,                  // true なら複数選択可
      "possible_values": ["ログイン", "検索", "決済", "通知"],  // list 型のみ
      "trackers": ["バグ", "機能"]       // どのトラッカーに紐づくか
    }
  ]
}
```

### エラー時

```jsonc
{
  "error": "カスタムフィールド一覧の取得に失敗しています（Redmine 管理者権限が必要）: ..."
}
```

その場合、`search_issues` の `custom_fields` 指定もエラーになる（ID 解決ができないため）。

---

## describe_schema

### 何をするか

プロジェクト・トラッカー・ステータス・カスタムフィールドを **1 回の呼び出しで全部取得**する。

セッション開始時に呼んでおくと、以降の `search_issues` で何を指定できるか LLM が把握できる。

### 引数

なし。

### 返却値

```jsonc
{
  "fetched_at": "2026-05-19T14:04:11.889Z",
  "projects": [
    { "id": 1, "identifier": "testredmine", "name": "TestRedmine" }
  ],
  "trackers": [
    { "id": 1, "name": "議事録" }
  ],
  "statuses": [
    { "id": 1, "name": "作成", "is_closed": false },
    { "id": 2, "name": "確認", "is_closed": false },
    { "id": 3, "name": "完了", "is_closed": false }   // ← is_closed=false なら open 扱い
  ],
  "custom_fields": [
    {
      "id": 5,
      "name": "カテゴリ",
      "field_format": "list",
      "possible_values": ["ログイン", "検索", "決済"]
    }
  ],
  "activities": [                  // 工数の作業分類（list_time_entries で使う）
    { "id": 9, "name": "設計", "is_default": false },
    { "id": 10, "name": "実装", "is_default": true },
    { "id": 11, "name": "テスト" }
  ]
}
```

CF が管理者権限不足で取れない場合：

```jsonc
"custom_fields": {
  "available": false,
  "reason": "Redmine API error: 403 Forbidden",
  "note": "..."
}
```

---

## refresh_metadata

### 何をするか

`describe_schema` / `list_projects` / `list_custom_fields` が裏で持っているキャッシュを破棄して再取得する。

**Redmine 側で**：
- 新しいプロジェクトを作った
- カテゴリの選択肢を追加した
- 新しいトラッカーを追加した

直後に呼ぶと、**MCP サーバーを再起動せずに反映**される。

### 引数

なし。

### 返却値

```jsonc
{
  "refreshed_at": "2026-05-19T14:30:00.000Z",
  "counts": {
    "projects": 1,
    "trackers": 1,
    "statuses": 3,
    "custom_fields": 3
  },
  "custom_fields_available": true,
  "custom_fields_error": null
}
```

---

## エラーレスポンスの共通形式

ツールが失敗すると、`isError: true` 付きで以下のような構造化テキストが返る：

```
プロジェクト 'foobar' が見つかりません。list_projects で確認してください。
```

または詳細付き：

```
Redmine API error: 401 Unauthorized

{
  "errors": ["Invalid API key"]
}
```

---

## 拡張する場合

新しいツールを追加する手順：

1. `src/tools/your-tool.ts` を作成（`src/tools/list-projects.ts` をテンプレートにすると最短）
2. 以下をエクスポート：
   ```ts
   export function register(server: McpServer, ctx: ToolContext) {
     server.registerTool("your_tool", { title, description, inputSchema }, async (args) => { ... });
   }
   ```
3. `src/index.ts` に `import` と `register(server, ctx)` 呼び出しを追加
4. `npm run build` → 再起動

このドキュメントもソースから再生成すること。
