# certs/

組織の社内 CA 証明書を置く場所。

## 使い方

### 1. 証明書ファイルを取得してこのディレクトリにコピー

ファイル名・拡張子は何でも OK（`.pem` / `.crt` / `.cer` 全部 OK）。**重要なのは中身**。

### 2. 中身が PEM か DER か判定する

メモ帳・VSCode などでファイルを開いてみる：

| 見た目 | 形式 | どうする |
|---|---|---|
| `-----BEGIN CERTIFICATE-----` で始まるテキスト | **PEM** | そのまま使える ✓ |
| 文字化け（バイナリ） | **DER** | 下記コマンドで変換が必要 |

#### DER → PEM 変換コマンド

```powershell
openssl x509 -inform DER -in internal-ca.cer -out internal-ca.pem
```

`openssl` は Git for Windows に同梱されている。なければ：
```powershell
winget install ShiningLight.OpenSSL.Light
```

### 3. `.env` にパス追記

プロジェクトルートの `.env` に：

```dotenv
NODE_EXTRA_CA_CERTS=certs/internal-ca.pem
```

- 相対パス指定可（`npm run dev` 実行ディレクトリ = プロジェクトルートから解決される）
- 拡張子は `.pem` でなくても OK（`certs/internal-ca.cer` でも中身が PEM なら動く）
- 半年後の自分のために `.pem` にリネームしておくと混乱しない

### 4. 起動

```powershell
npm run dev
```

`[redmine-mcp] started` が出れば成功。エラーが出たら下の「よくあるエラー」参照。

## よくあるエラー

| エラー本文 | 原因 | 対処 |
|---|---|---|
| `unable to verify the first certificate` | 中間 CA 不足 | 配布元に「完全な証明書チェーン」を依頼 |
| `self-signed certificate in certificate chain` | プロキシ MITM 証明書 | プロキシの CA も `NODE_EXTRA_CA_CERTS` に含める |
| `error:0909006C:PEM routines` | ファイル形式不一致 | DER の可能性。openssl で PEM に変換 |
| `ENOENT: no such file or directory` | パス間違い | `.env` のパスが相対なら `npm run dev` の起動ディレクトリ確認 |

## なぜ `--use-system-ca` で済まないことがあるか

Windows の証明書ストアに「ユーザー」ストアと「マシン」ストアがあり、企業によっては片方にしか入っていない / 配布方式が PEM ファイル単独だったりするため。`certs/` 方式は **ファイル単独で完結する** ので確実。

## セキュリティ

- このディレクトリ配下の **`.pem` / `.crt` / `.cer` ファイルは `.gitignore` で自動的に追跡対象外**（ホワイトリスト方式のため、明示的に許可していない拡張子は無視される）
- `git status` で証明書ファイルが見えないことを確認してから commit すること
