# 設計書 / アーキテクチャ（redmine-mcp）

> このプロジェクトのコードを修正する前に、まずこのドキュメントを読むこと。
> 全体構成・設計思想・拡張方法・注意点をまとめてある。
> ツールごとの引数仕様は [TOOLS.md](TOOLS.md)、利用者向けの導入は [../README.md](../README.md)。

---

## 1. これは何か

Redmine の REST API を MCP（Model Context Protocol）ツールとして公開するサーバー。
AI エージェント（GitHub Copilot CLI / Claude Code 等）が、Redmine のチケットを
検索・集計・分析するために使う。**読み取り専用**。

- 言語: TypeScript（ESM、Node.js 22+）
- 依存: `@modelcontextprotocol/sdk` と `zod` のみ
- 通信: Node 標準の `fetch`

## 2. 設計思想（修正時もこれを守る）

| 原則 | 理由 | 修正時の含意 |
|---|---|---|
| **読み取り専用** | AI に誤更新させない安全策 | 書き込み系 API（POST/PUT/DELETE）は実装しない |
| **依存最小** | サプライチェーンリスク低減 | 新しい npm パッケージ追加は慎重に。標準 API で済むなら使わない |
| **名前で指定、ID は内部** | 人間／LLM に優しい | プロジェクト・トラッカー・CF 等は日本語名で受け取り、内部で ID 解決 |
| **ツール説明文＝ LLM の取扱説明書** | LLM は description を読んで使い方を判断する | description は丁寧に書く。挙動を変えたら description も必ず更新 |
| **トークン効率** | LLM 経由なので応答量がコスト | 大きい生データを返さない工夫（count_only, 集計, サーバー側 CSV） |
| **エラーは構造化** | LLM が自己訂正できるように | 不正値には「利用可能な値の一覧」を返す |

## 3. 全体構成

```
src/
├── index.ts              エントリポイント。設定読込 → ツール登録 → MCP 起動
├── types.ts              Redmine API レスポンスの型定義
├── redmine/
│   ├── client.ts         Redmine REST API の薄いラッパー（fetch・リトライ・ページネーション）
│   └── metadata.ts       メタ情報キャッシュ（TTL 付き）・名前→ID 解決
└── tools/
    ├── context.ts        ツール共通基盤（下記参照）
    ├── csv.ts            CSV 生成共通（BOM・エスケープ・ファイル書き出し）
    ├── search-issues.ts      チケット条件検索
    ├── quick-search.ts       全文検索
    ├── get-issue.ts          チケット詳細
    ├── export-issues-csv.ts  チケット CSV エクスポート
    ├── list-time-entries.ts  工数取得・集計
    ├── aggregate-issues.ts   クロス集計
    ├── list-projects.ts      プロジェクト一覧
    ├── list-custom-fields.ts カスタムフィールド一覧
    ├── describe-schema.ts    スキーマ一括取得
    └── refresh-metadata.ts   キャッシュ再取得
```

### レイヤー構造

```
MCP クライアント（Copilot CLI / Claude Code）
        ↓ MCP プロトコル（stdio）
index.ts（登録された各ツール）
        ↓
tools/*.ts（引数バリデーション・名前解決・整形）
        ↓ ToolContext 経由
redmine/metadata.ts（名前→ID 解決）   redmine/client.ts（HTTP）
        ↓                                    ↓
                              Redmine REST API
```

## 4. リクエストのライフサイクル

`search_issues` を例に：

1. LLM が `search_issues({ project: "...", status: "完了", ... })` を呼ぶ
2. `index.ts` が登録したハンドラが起動、zod が引数を検証
3. `await ctx.metadata.get()` でメタ情報キャッシュを取得（TTL 切れなら再取得）
4. 名前を ID に解決：`project` → identifier、`status` 名 → status_id、CF 名 → `cf_<id>`
5. `ctx.client.listIssues(params, limit)` で Redmine API を叩く（client がリトライ・ページネーション処理）
6. レスポンスを `trimIssueForList()` で要約形に整形
7. `jsonResult(...)` で MCP レスポンスとして返す

## 5. モジュール責務

### `index.ts`
- `.env` から設定読込（`REDMINE_URL` / `REDMINE_API_KEY` / `REDMINE_TIMEOUT_MS` / `REDMINE_PROJECTS`）
- `RedmineClient` と `MetadataCache` を生成し `ToolContext` を組む
- 各ツールの `register(server, ctx)` を呼ぶ
- **ツールを増やしたらここに import と register 呼び出しを足す**

### `redmine/client.ts`
- Redmine REST API への `fetch` ラッパー
- **リトライ**：ネットワークエラー・5xx は最大 3 回再試行（4xx は即失敗）
- **ページネーション**：`requestAllPaginated()` が全ページを取得
- エンドポイントごとのメソッド（`listIssues`, `getIssue`, `search`, `listTimeEntries` 等）
- `RedmineApiError` を投げる

### `redmine/metadata.ts`
- プロジェクト・トラッカー・ステータス・CF・Activity を**起動時に取得しキャッシュ**
- **TTL 15 分**：古くなったら `get()` で自動再取得（手動 `refresh_metadata` も可）
- 名前→ID 解決メソッド（`resolveCustomFieldId`, `resolveTrackerId` 等）
- `REDMINE_PROJECTS` 設定時はプロジェクトをスコープ内に絞る
- `custom_fields.json` は管理者権限が必要。管理者トークンなら API から取得し、403 等で失敗したら `deriveCustomFieldsFromIssues()` で issue データ（500 件走査）から CF の id↔名前・観測値を復元する（issue-scan フォールバック）。取得元は `customFieldsSource`（`api` / `issue-scan` / `none`）に保持

### `tools/context.ts`（共通基盤）
- `ToolContext` 型（`client` と `metadata`）
- `jsonResult()` / `errorResult()` — MCP レスポンス生成
- `selectProjects()` — `project` 引数 → スコープ解決（single / fan-out / unscoped / error）
- `fetchIssuesForSelection()` — スコープに応じた issue 取得（fan-out 時は並列＋マージ）
- `sortIssuesBySpec()` — fan-out マージ後の再ソート
- `resolveCfFilterValue()` — CF フィルタ値の解決（exact / partial、リスト型と文字列型で分岐）
- `localDateString()` — ローカルタイムゾーンの「今日」（UTC ずれ対策）

### `tools/csv.ts`（CSV 共通）
- `toCsv()` — UTF-8 BOM + CRLF、セルエスケープ
- `writeCsv()` — `exports/` に書き出してパスを返す
- `export_issues_csv` / `aggregate_issues` / `list_time_entries` の CSV 出力が共用

### `tools/*.ts`（各ツール）
- 1 ファイル 1 ツール
- `register(server: McpServer, ctx: ToolContext)` をエクスポート
- 中で `server.registerTool(name, { title, description, inputSchema }, handler)` を呼ぶ

## 6. ツールの実装パターン

全ツールが同じ形：

```typescript
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { jsonResult, errorResult, type ToolContext } from "./context.js";

const inputShape = {
  someArg: z.string().optional().describe("引数の説明（LLM が読む）"),
};

export function register(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "tool_name",
    {
      title: "人間向けの短い名前",
      description: "LLM 向けの詳しい説明。いつ・どう使うかを書く。",
      inputSchema: inputShape,
    },
    async (args) => {
      // 1. メタ情報が要るなら await ctx.metadata.get()
      // 2. 名前→ID 解決
      // 3. ctx.client.xxx() で API 呼び出し
      // 4. 整形して jsonResult(...) / 失敗は errorResult(...)
    },
  );
}
```

## 7. 重要な仕組み

### 名前→ID 解決
ユーザー／LLM は日本語名（プロジェクト名・トラッカー名・CF 名）で指定する。
`MetadataCache` がキャッシュした一覧と照合して ID に変換する（大文字小文字無視・trim）。
**`await ctx.metadata.get()` を呼んだ後でないと解決できない**点に注意。

### カスタムフィールドのフィルタ（`resolveCfFilterValue`）
- exact モード：値をそのまま `cf_<id>=<値>` に
- partial モード：
  - **リスト型 CF**：Redmine の `~` 演算子はリスト型に効かないため、選択肢から
    入力文字列を含むものを 1 つ特定し、その完全な値に置換する
  - **文字列型 CF**：Redmine の `~`（部分一致）を使う

### プロジェクトスコープと fan-out
`REDMINE_PROJECTS` が設定されていると厳格モードになる。`selectProjects()` が
`single`（1 プロジェクト）/ `fanOut`（複数並列）/ `unscoped`（全体）/ `error` を返し、
`fetchIssuesForSelection()` がそれに応じて取得する。fan-out 時は各プロジェクトに
並列クエリしてマージ → `sortIssuesBySpec()` で再ソート。

### メタ情報キャッシュ
起動時に 1 回取得。TTL 15 分で自動再取得。Redmine 側で CF を追加したら
最大 15 分で追従するが、即時反映したいなら `refresh_metadata` ツールを呼ぶ。

## 8. 拡張方法

### 新しいツールを追加する
1. `src/tools/<name>.ts` を作成（`list-projects.ts` が最小の雛形）
2. `register(server, ctx)` をエクスポート
3. `src/index.ts` に import と `register()` 呼び出しを追加
4. `docs/TOOLS.md` に仕様を追記
5. `npm run build`

### `search_issues` にフィルタを追加する
1. `inputShape` に zod でフィールドを追加（`describe()` を必ず書く）
2. ハンドラ内で `params` に Redmine のクエリパラメータをセット
3. Redmine のフィルタ記法に注意（日付範囲は `><`、部分一致は `~` 等）

### CSV に列を追加する
`export-issues-csv.ts` の `STANDARD_COLUMNS` と `columnValue()` に追記。

## 9. 変更時の注意点（ハマりどころ）

- **description を更新し忘れない**：挙動を変えたらツールの `description` も直す。
  LLM はそれを読んで動くので、ズレると誤動作する。
- **タイムゾーン**：「今日」は `localDateString()` を使う。`new Date().toISOString()`
  は UTC でずれる。
- **メタ情報キャッシュ**：名前解決の前に `await ctx.metadata.get()` が必要。
- **CF 取得の二段構え**：`custom_fields.json`（管理者専用）が失敗したら issue 走査で
  CF を復元する。この自動フォールバック（`metadata.ts` の `load()` →
  `deriveCustomFieldsFromIssues()`）を壊さないこと。走査由来の CF は
  `possible_values` が観測値のみ・`field_format` が推定値になる点に注意。
- **Redmine の特殊値**：`status_id` は `open` / `closed` / `*`、CF は `cf_<id>`。
- **IDE の誤検知**：エディタ上で `process` `fetch` 等に赤線が出ることがあるが、
  `npm run build`（tsc）が通れば問題ない（IDE の TS サーバーの不調）。
- **環境固有情報を書かない**：git 追跡されるファイル（src・docs・README・
  `.example.md`）に実フィールド名・実データ・URL・API キーを書かない。
  業務固有のものは `copilot-instructions.md`（追跡対象外）か `memo/` に。

## 10. 動作確認

```bash
npm run build                              # ビルド（tsc）
npx tsc --noEmit --noUnusedLocals --noUnusedParameters   # 未使用コード検出
node scripts/smoke-test.mjs                # 実 Redmine に対する疎通テスト（.env 必要）
```

`smoke-test.mjs` は MCP プロトコル経由で主要ツールを叩く簡易テスト。
コード修正後はこれで回帰がないか確認する。

## 11. 制約

- Redmine REST API 4.x 以降を想定（API は安定しているが古い版は未確認）
- `custom_fields.json` / `users.json` は管理者権限が必要（どちらも非 admin 時の
  フォールバックあり：CF は issue 走査で復元、担当者名解決は文字列のまま Redmine に委譲）
- 書き込み操作は非対応（設計上の意図）
