# redmine-mcp

Redmine のチケット検索・集計・分析を、AI エージェント（GitHub Copilot CLI / Claude Code / Cursor 等）から自然言語で行うための MCP サーバー。

## 何ができるか

- 「未完了のチケットを担当者別に集計して」
- 「カテゴリが "ログイン" のバグチケット一覧」
- 「チケット #1234 のバグの原因を分析して」
- 「先週更新されたチケットを教えて」
- 「ログインまわりのチケットをざっくり探して」（全文検索）
- 「期限切れチケットを CSV で出力して」（Excel 対応 CSV をサーバー側生成）

カスタムフィールド（"カテゴリ" など）は**フィールド名のまま指定可能**。Redmine 側で新しい選択肢を追加しても、コード修正なしで使えます（`refresh_metadata` ツールで反映）。

## セットアップ手順（クリーン環境から）

### 0. 必要環境

- **Node.js 22 以上**（22 LTS または 24 LTS 推奨）
  - 確認: `node --version`
  - 未インストールなら https://nodejs.org/ から
- Git（コード取得に使う場合）

### 1. コードを取得

git を使う場合：
```powershell
git clone <このリポジトリ URL> Redmine
cd Redmine
```

zip / USB でコピーした場合は、解凍後そのディレクトリに `cd`。

### 2. 依存インストール

```powershell
npm install
```

`added N packages, found 0 vulnerabilities` のような出力が出れば OK。

### 3. ビルド

```powershell
npm run build
```

`dist/` ディレクトリが生成される。

### 4. `.env` を作成

PowerShell:
```powershell
Copy-Item .env.example .env
```

Git Bash / WSL:
```bash
cp .env.example .env
```

`.env` をエディタ（VSCode/メモ帳など）で開いて編集する。

### 最小構成（必須項目だけ）

```dotenv
REDMINE_URL=https://redmine.example.com
REDMINE_API_KEY=xxxxxxxxxxxxxxxxxxxx
```

API キーは Redmine の **個人設定 → 右側「API アクセスキー」→「表示」** から取得。

### 推奨構成（プロジェクトスコープを使う場合）

会社のように大量プロジェクトがある Redmine では、対象を絞ると安全＆効率的：

```dotenv
REDMINE_URL=https://redmine.example.com
REDMINE_API_KEY=xxxxxxxxxxxxxxxxxxxx
REDMINE_PROJECTS=my-product,my-product-mobile
```

`REDMINE_PROJECTS` には **プロジェクトの identifier**（URL の `/projects/` 直後の部分）を**カンマ区切り**で列挙。

#### identifier の確認方法

Redmine でプロジェクトのトップページを開いたときの URL：
```
https://redmine.company.com/projects/my-product
                                     ^^^^^^^^^^
                                     ← これが identifier
```

#### スコープを設定すると

- `describe_schema` / `list_projects` は列挙したプロジェクトだけ返す
- 各ツールの `project` 引数にスコープ外を指定するとエラー（「他チームを誤って覗く」を防止）
- `project` 引数省略時はスコープ内全プロジェクトに**並列問い合わせ**（fan-out）して結果マージ
- スコープに含めた identifier が実在しない場合は自動的に除外（404 にならない）

### 会社環境用のフルセット例

社内 CA 証明書を `certs/` に置く運用なら：

```dotenv
REDMINE_URL=https://redmine.company.com
REDMINE_API_KEY=xxxxxxxxxxxxxxxxxxxx
REDMINE_PROJECTS=my-product,my-product-mobile,internal-tools
NODE_EXTRA_CA_CERTS=certs/company-ca.pem
```

これで起動すれば：
- 社内 CA 経由で接続
- 3 プロジェクトだけ対象
- 他チームのプロジェクトには触れない

### 5. （会社環境のみ）社内 CA 証明書を配置

社内 CA で署名された Redmine に接続する場合は、後述の「[会社環境](#会社環境社内-ca自己署名証明書を使う-redmine-の場合)」セクションを参照。証明書を `certs/` に置いて `.env` に `NODE_EXTRA_CA_CERTS=certs/...` を追記。

### 6. 動作確認

```powershell
npm run dev
```

`[redmine-mcp] started` と出れば OK（stdin/stdout で待機します。Ctrl+C で停止）。

接続できない場合は[トラブルシューティング](#トラブルシューティング)参照。

### 7. MCP クライアントへ登録

次の「[MCP クライアントへの登録](#mcp-クライアントへの登録)」セクション参照。

## MCP クライアントへの登録

このプロジェクトには **`.mcp.json` が同梱されている**ので、ほとんどの MCP クライアントは**プロジェクトディレクトリで起動するだけ**で redmine MCP を自動認識します。

### GitHub Copilot CLI

#### 方法 ①（推奨）: `.mcp.json` 自動認識

このプロジェクトディレクトリで `copilot` を起動するだけ：

```powershell
cd C:\path\to\Redmine    # このリポジトリのルート
copilot
```

`.mcp.json` がワークスペース設定として自動読み込みされる。確認：

```powershell
copilot mcp list
# → Workspace servers: redmine (local) と出ればOK
```

#### 方法 ②: ユーザー設定（どこからでも使いたい場合）

`~/.copilot/mcp-config.json` に登録すれば任意のディレクトリから利用可能：

```powershell
copilot mcp add redmine `
  --env REDMINE_URL=https://redmine.example.com `
  --env REDMINE_API_KEY=xxxxxxxxxxxxxxxxxxxx `
  -- node --use-system-ca <このプロジェクトの絶対パス>/dist/index.js
```

> ユーザー設定だと `--env-file=.env` の相対パス解決が効かないので、`--env` で直接環境変数を渡す。

### Claude Code

#### 方法 ①（推奨）: `.mcp.json` 自動認識

VSCode を **このプロジェクトのフォルダで開く**だけ。Claude Code 拡張が `.mcp.json` を検出し、初回起動時に承認ダイアログが出るので Approve。

承認後の確認は、新しい会話で：

```
使える MCP ツール一覧を見せて
```

#### 方法 ②: ユーザー設定（どこのプロジェクトからでも使いたい場合）

`~/.claude/settings.json` の `mcpServers` キーに追記：

```json
{
  "mcpServers": {
    "redmine": {
      "command": "node",
      "args": ["--env-file=.env", "--use-system-ca", "<このプロジェクトの絶対パス>/dist/index.js"],
      "cwd": "<このプロジェクトの絶対パス>"
    }
  }
}
```

VSCode を再起動。

> パスは Windows でも JSON 内では `/` 区切り推奨（`\` だとエスケープが面倒）。

### 共通の注意

- `.mcp.json` 方式の場合、**MCP クライアントを起動した CWD がプロジェクトディレクトリ**であることが必要
- 動作確認後に `.env` の値を変えたら、クライアントを再起動して MCP サーバープロセスを再生成すること（プロセス起動時にしか `.env` は読まれない）

## 提供ツール

| ツール | 用途 |
|---|---|
| `search_issues` | チケットを条件で厳密に検索。overdue / count_only / parent_id 等の便利フィルタあり |
| `quick_search` | 曖昧なキーワードで全文検索（件名・本文・コメント横断） |
| `get_issue` | チケット詳細 + コメント履歴 + 関連チケット |
| `export_issues_csv` | チケットを CSV エクスポート（**サーバー側生成で高速・Excel 対応**） |
| `list_time_entries` | 工数集計（**親チケットの子全件一括対応**） |
| `aggregate_issues` | クロス集計（**トークン節約・サーバー側集計**） |
| `list_projects` | プロジェクト一覧 |
| `list_custom_fields` | カスタムフィールド一覧（要管理者権限） |
| `describe_schema` | スキーマ全体（プロジェクト・トラッカー・ステータス・CF・Activity）を一括取得 |
| `refresh_metadata` | キャッシュ再取得（CF / Activity 追加時など） |

**詳細な仕様（引数・返却値・サンプルクエリ）は [docs/TOOLS.md](docs/TOOLS.md) 参照。**

## ツール追加方法

1. `src/tools/your-tool.ts` を新規作成
2. `register(server, ctx)` 関数をエクスポート
3. `src/index.ts` に `import` と `register` 呼び出しを追加

既存ツールがテンプレートとして使えます。`src/tools/list-projects.ts` が一番シンプル。

**コードを修正・拡張する場合は、まず [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)（設計書）を読んでください。** 全体構成・設計思想・拡張手順・注意点がまとまっています。

## 会社環境（社内 CA・自己署名証明書を使う Redmine の場合）

Node.js は**デフォルトで Windows の証明書ストアを参照しません**。社内 CA で署名された Redmine に接続すると「自己署名証明書」エラーになります。

### 解決策 ①（推奨）: `--use-system-ca`

`package.json` の `dev` / `start` スクリプトには **`--use-system-ca` フラグが付与済み**です。Windows 証明書ストアに会社の社内 CA がインストール済みであれば、追加作業なしで接続できます。

```bash
npm run dev     # 内部で node --use-system-ca が走る
```

### 解決策 ②: `NODE_EXTRA_CA_CERTS`（ファイル方式・推奨フォールバック）

①でも通らない場合、または「ツール直下に証明書を持たせて移植性を高めたい」場合：

1. 会社で配布された証明書（`.crt` / `.cer` / `.pem`）を **`certs/` ディレクトリにコピー**
   - 詳細手順は [certs/README.md](certs/README.md) 参照
2. `.env` に追記：
   ```
   NODE_EXTRA_CA_CERTS=certs/company-ca.pem
   ```
3. `npm run dev`

`certs/` 配下の `.pem` / `.crt` / `.cer` ファイルは `.gitignore` で**自動的に追跡対象外**なので、誤コミットの心配なし。

### やってはいけない

`NODE_TLS_REJECT_UNAUTHORIZED=0` で証明書検証を無効化するのは**絶対に NG**。
MITM 攻撃に無防備になります。トラブルシューティングの一時手段として使うのも避けてください。

## トラブルシューティング

| 症状 | 対処 |
|---|---|
| `REDMINE_URL が設定されていません` | `.env` を作成・編集 |
| `Redmine API error: 401` | API キーが間違っている |
| `Redmine API error: 403`（custom_fields） | 管理者権限のあるユーザーの API キーが必要。なくても他のツールは動く |
| `self-signed certificate` / `unable to verify the first certificate` | 上記「会社環境」セクション参照 |
| カスタムフィールド名で絞り込めない | `list_custom_fields` で実際の名前を確認、または `refresh_metadata` |
| 件数が多すぎて切り捨てられた | `search_issues` の `limit` を増やすか条件を絞る |
| 完全一致でしかヒットしない | 曖昧検索は `quick_search`、CF 値の部分一致は `custom_field_match: "partial"` |
| CSV 出力が遅い | `export_issues_csv` を使う（サーバー側生成で高速。LLM に表を書かせない） |
| CSV を Excel で開くと文字化け | `export_issues_csv` は UTF-8 BOM 付きで出力するので化けない。手書き CSV なら BOM を付ける |

## アーキテクチャ

```
src/
├── index.ts              # MCP サーバー起動・ツール登録
├── types.ts              # Redmine API レスポンスの型定義
├── redmine/
│   ├── client.ts         # fetch ベースの薄い API ラッパー
│   └── metadata.ts       # CF/トラッカー/ステータス/プロジェクト/Activity のキャッシュ
└── tools/
    ├── context.ts        # ツール共通の型・ヘルパー（スコープ解決・fan-out 等）
    ├── search-issues.ts        # 条件検索
    ├── quick-search.ts         # 全文検索
    ├── get-issue.ts            # チケット詳細
    ├── export-issues-csv.ts    # CSV エクスポート
    ├── list-time-entries.ts    # 工数集計
    ├── aggregate-issues.ts     # クロス集計
    ├── list-projects.ts
    ├── list-custom-fields.ts
    ├── describe-schema.ts
    └── refresh-metadata.ts
```

出力先 `exports/`（CSV）と `certs/`（証明書）はランタイムで生成・配置される。

依存は `@modelcontextprotocol/sdk` と `zod` のみ（サプライチェーン最小化）。HTTP は Node 標準の `fetch`、環境変数は `node --env-file`、CSV 書き出しは `node:fs` を利用。

詳しい設計（レイヤー構造・各モジュールの責務・拡張方法・修正時の注意点）は **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** にまとめています。
