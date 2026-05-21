#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RedmineClient } from "./redmine/client.js";
import { MetadataCache } from "./redmine/metadata.js";
import type { ToolContext } from "./tools/context.js";

import * as searchIssues from "./tools/search-issues.js";
import * as getIssue from "./tools/get-issue.js";
import * as listCustomFields from "./tools/list-custom-fields.js";
import * as listProjects from "./tools/list-projects.js";
import * as describeSchema from "./tools/describe-schema.js";
import * as refreshMetadata from "./tools/refresh-metadata.js";
import * as listTimeEntries from "./tools/list-time-entries.js";
import * as aggregateIssues from "./tools/aggregate-issues.js";
import * as quickSearch from "./tools/quick-search.js";
import * as exportIssuesCsv from "./tools/export-issues-csv.js";

function readConfig() {
  const url = process.env.REDMINE_URL;
  const apiKey = process.env.REDMINE_API_KEY;
  const timeoutMs = process.env.REDMINE_TIMEOUT_MS
    ? Number(process.env.REDMINE_TIMEOUT_MS)
    : 30000;
  const projectsEnv = process.env.REDMINE_PROJECTS;
  const projectScope = projectsEnv
    ? projectsEnv
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : undefined;

  if (!url) {
    throw new Error(
      "REDMINE_URL が設定されていません。.env を確認してください。",
    );
  }
  if (!apiKey) {
    throw new Error(
      "REDMINE_API_KEY が設定されていません。.env を確認してください。",
    );
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `REDMINE_TIMEOUT_MS の値が不正です: ${process.env.REDMINE_TIMEOUT_MS}`,
    );
  }

  return {
    url: url.replace(/\/+$/, ""),
    apiKey,
    timeoutMs,
    projectScope: projectScope && projectScope.length > 0 ? projectScope : undefined,
  };
}

async function main() {
  const config = readConfig();
  const client = new RedmineClient(config);
  const metadata = new MetadataCache(client);
  const ctx: ToolContext = { client, metadata };

  const server = new McpServer({
    name: "redmine-mcp",
    version: "0.1.0",
  });

  searchIssues.register(server, ctx);
  getIssue.register(server, ctx);
  listCustomFields.register(server, ctx);
  listProjects.register(server, ctx);
  describeSchema.register(server, ctx);
  refreshMetadata.register(server, ctx);
  listTimeEntries.register(server, ctx);
  aggregateIssues.register(server, ctx);
  quickSearch.register(server, ctx);
  exportIssuesCsv.register(server, ctx);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Warm the metadata cache in the background so the first user query is fast.
  // Failures are non-fatal — the cache will be populated on demand.
  metadata
    .get()
    .then((m) => {
      if (m.customFieldsSource === "issue-scan") {
        process.stderr.write(
          `[redmine-mcp] custom_fields.json は管理者専用のため取得不可。` +
            `issue データから ${m.customFields.length} 件のカスタムフィールドを復元しました。\n`,
        );
      } else if (m.customFieldsSource === "none") {
        process.stderr.write(
          `[redmine-mcp] カスタムフィールド情報を取得できませんでした: ${m.customFieldsError ?? "不明"}\n`,
        );
      }
    })
    .catch((err) => {
      process.stderr.write(
        `[redmine-mcp] 起動時のメタ情報取得に失敗（後で再取得されます）: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    });

  process.stderr.write("[redmine-mcp] started\n");
}

main().catch((err) => {
  process.stderr.write(
    `[redmine-mcp] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
