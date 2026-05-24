#!/usr/bin/env node
// MCP プロトコル経由で実 Redmine 相手にツールを叩く統合スモークテスト。
// 用途: 動作確認のみ。CI や継続実行は想定していない。

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const child = spawn("node", ["--env-file=.env", "dist/index.js"], {
  stdio: ["pipe", "pipe", "inherit"],
});

let buffer = "";
const pending = new Map();
let nextId = 1;

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch (err) {
      console.error("parse error:", err, "line:", line);
    }
  }
});

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function unwrap(res) {
  if (res.error) return `ERROR: ${JSON.stringify(res.error)}`;
  const text = res.result?.content?.[0]?.text;
  if (!text) return res.result;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function main() {
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "0" },
  });

  // 起動直後はメタ情報取得が走るので少し待つ
  await sleep(800);

  console.log("\n=== describe_schema ===");
  const schema = unwrap(await rpc("tools/call", {
    name: "describe_schema",
    arguments: {},
  }));
  console.log(JSON.stringify({
    projects: schema.projects?.length,
    trackers: schema.trackers,
    statuses: schema.statuses,
    custom_fields: Array.isArray(schema.custom_fields)
      ? schema.custom_fields.length
      : schema.custom_fields,
  }, null, 2));

  console.log("\n=== search_issues (status=all, limit=5) ===");
  const all = unwrap(await rpc("tools/call", {
    name: "search_issues",
    arguments: { project: "testredmine", status: "all", limit: 5 },
  }));
  console.log(JSON.stringify({
    total_count: all.total_count,
    returned: all.returned,
    query: all.query,
    first_issue: all.issues?.[0],
  }, null, 2));

  console.log("\n=== search_issues (status=完了, limit=3) ===");
  const closed = unwrap(await rpc("tools/call", {
    name: "search_issues",
    arguments: { project: "testredmine", status: "完了", limit: 3 },
  }));
  console.log(JSON.stringify({
    total_count: closed.total_count,
    returned: closed.returned,
    query: closed.query,
    subjects: closed.issues?.map((i) => `#${i.id} ${i.subject} (${i.status})`),
  }, null, 2));

  console.log("\n=== search_issues (status=作成, sort=priority:desc, limit=3) ===");
  const high = unwrap(await rpc("tools/call", {
    name: "search_issues",
    arguments: {
      project: "testredmine",
      status: "作成",
      sort: "priority:desc",
      limit: 3,
    },
  }));
  console.log(JSON.stringify({
    total_count: high.total_count,
    returned: high.returned,
    subjects: high.issues?.map(
      (i) => `#${i.id} ${i.subject} [${i.status}/${i.priority}]`,
    ),
  }, null, 2));

  if (all.issues?.[0]?.id) {
    const firstId = all.issues[0].id;
    console.log(`\n=== get_issue (#${firstId}) ===`);
    const detail = unwrap(await rpc("tools/call", {
      name: "get_issue",
      arguments: { id: firstId },
    }));
    console.log(JSON.stringify({
      id: detail.id,
      subject: detail.subject,
      status: detail.status?.name,
      description_length: detail.description?.length ?? 0,
      journals_count: detail.journals?.length ?? 0,
      relations_count: detail.relations?.length ?? 0,
    }, null, 2));

    console.log(`\n=== review_issue (#${firstId}, required_fields + include_attachments) ===`);
    const review = unwrap(await rpc("tools/call", {
      name: "review_issue",
      arguments: {
        issue_id: firstId,
        required_fields: ["assigned_to", "due_date", "description"],
        include_attachments: true,
      },
    }));
    console.log(JSON.stringify({
      issue_subject: review.issue?.subject,
      status_is_closed: review.issue?.status_is_closed,
      completeness: review.completeness,
      consistency_flags: review.consistency_flags,
      attachments_count: review.attachments?.length ?? 0,
      first_attachment: review.attachments?.[0],
    }, null, 2));

    const firstAttachment = review.attachments?.[0];
    if (firstAttachment) {
      console.log(`\n=== download_attachment (#${firstAttachment.id}) ===`);
      const dl = unwrap(await rpc("tools/call", {
        name: "download_attachment",
        arguments: { issue_id: firstId, attachment_id: firstAttachment.id },
      }));
      console.log(JSON.stringify({
        filename: dl.filename,
        kind: dl.kind,
        content_type: dl.content_type,
        size_bytes: dl.size_bytes,
        relative_path: dl.relative_path,
      }, null, 2));
    } else {
      console.log("\n=== download_attachment: skipped (no attachments on first issue) ===");
    }
  }

  child.kill();
  process.exit(0);
}

main().catch((err) => {
  console.error("smoke test failed:", err);
  child.kill();
  process.exit(1);
});
