import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import type { ChatMessage, ImageAttachment } from "../types.js";
import { getDb } from "./chat-storage.js";
import {
  hydrateToolResultImageAttachment,
  saveToolResultImage,
  stripToolResultImageData,
} from "./tool-result-image-storage.js";

export interface ToolResultImagePayloadMigrationOptions {
  dryRun?: boolean;
  limit?: number;
}

export interface ToolResultImagePayloadMigrationResult {
  dryRun: boolean;
  scannedRows: number;
  changedRows: number;
  strippedAttachments: number;
  persistedAttachments: number;
  skippedAttachments: number;
  skippedMissingDataBytes: number;
  removedBase64Bytes: number;
  beforeInlineAttachments: number;
  beforeInlineBase64Bytes: number;
  afterInlineAttachments: number;
  afterInlineBase64Bytes: number;
  skipped: Array<{
    chatId: string;
    sequence: number;
    toolName?: string;
    imageName?: string;
    reason: "missing-storage" | "mismatched-file" | "persist-failed" | "invalid-message";
  }>;
}

interface InlineToolImageSummary {
  count: number;
  totalBase64Bytes: number;
}

interface InlineToolImageRow {
  chat_id: string;
  sequence: number;
  payload_json: string;
}

export function inlineToolResultImageSummary(db: Database.Database = getDb()): InlineToolImageSummary {
  return db.prepare(`
    SELECT
      COUNT(img.key) AS count,
      COALESCE(SUM(length(COALESCE(json_extract(img.value, '$.data'), ''))), 0) AS totalBase64Bytes
    FROM (
      SELECT payload_json
      FROM chat_message_rows
      WHERE json_valid(payload_json)
        AND json_type(payload_json, '$.toolResults') = 'array'
    ) r
    JOIN json_each(r.payload_json, '$.toolResults') tr
    JOIN json_each(tr.value, '$.images') img
    WHERE json_type(tr.value, '$.images') = 'array'
      AND length(COALESCE(json_extract(img.value, '$.data'), '')) > 0
  `).get() as InlineToolImageSummary;
}

function inlineToolImageRows(db: Database.Database, limit?: number): InlineToolImageRow[] {
  const limitClause = limit && Number.isFinite(limit) && limit > 0 ? "LIMIT ?" : "";
  const sql = `
    SELECT DISTINCT r.chat_id, r.sequence, r.payload_json
    FROM chat_message_rows r
    JOIN json_each(r.payload_json, '$.toolResults') tr
    JOIN json_each(tr.value, '$.images') img
    WHERE json_valid(r.payload_json)
      AND json_type(r.payload_json, '$.toolResults') = 'array'
      AND json_type(tr.value, '$.images') = 'array'
      AND length(COALESCE(json_extract(img.value, '$.data'), '')) > 0
    ORDER BY r.timestamp ASC, r.chat_id ASC, r.sequence ASC
    ${limitClause}
  `;
  return limitClause
    ? db.prepare(sql).all(limit) as InlineToolImageRow[]
    : db.prepare(sql).all() as InlineToolImageRow[];
}

function hasStoragePointer(image: ImageAttachment): boolean {
  return Boolean(image.id && image.url);
}

async function persistToolImage(image: ImageAttachment, preferredId?: string): Promise<ImageAttachment> {
  if (!image.data) throw new Error("image has no data");
  const record = await saveToolResultImage(
    preferredId || randomUUID(),
    Buffer.from(image.data, "base64"),
    image.mimeType,
    image.name,
  );
  return {
    mimeType: image.mimeType,
    name: image.name,
    id: record.id,
    url: record.url,
  };
}

export async function migrateToolResultImagePayloads(
  options: ToolResultImagePayloadMigrationOptions = {},
): Promise<ToolResultImagePayloadMigrationResult> {
  const dryRun = options.dryRun !== false;
  const db = getDb();
  const before = inlineToolResultImageSummary(db);
  const rows = inlineToolImageRows(db, options.limit);
  const updates: Array<{ chatId: string; sequence: number; payloadJson: string }> = [];
  const skipped: ToolResultImagePayloadMigrationResult["skipped"] = [];

  let strippedAttachments = 0;
  let persistedAttachments = 0;
  let skippedAttachments = 0;
  let skippedMissingDataBytes = 0;
  let removedBase64Bytes = 0;

  for (const row of rows) {
    let message: ChatMessage;
    try {
      message = JSON.parse(row.payload_json) as ChatMessage;
    } catch {
      skipped.push({ chatId: row.chat_id, sequence: row.sequence, reason: "invalid-message" });
      continue;
    }

    if (!Array.isArray(message.toolResults)) continue;

    let changed = false;
    const toolResults = [];

    for (const toolResult of message.toolResults) {
      if (!Array.isArray(toolResult.images)) {
        toolResults.push(toolResult);
        continue;
      }

      const images: ImageAttachment[] = [];
      for (const image of toolResult.images) {
        const inlineBytes = image.data?.length ?? 0;
        if (!inlineBytes) {
          images.push(image);
          continue;
        }

        const stripped = stripToolResultImageData(image);
        const hydrated = image.id ? await hydrateToolResultImageAttachment(stripped) : stripped;
        if (hydrated.data === image.data && hasStoragePointer(stripped)) {
          images.push(stripped);
          strippedAttachments++;
          removedBase64Bytes += inlineBytes;
          changed = true;
          continue;
        }

        if (dryRun) {
          images.push(stripped);
          persistedAttachments++;
          removedBase64Bytes += inlineBytes;
          changed = true;
          continue;
        }

        try {
          const persisted = await persistToolImage(image, image.id);
          images.push(persisted);
          persistedAttachments++;
          removedBase64Bytes += inlineBytes;
          changed = true;
          continue;
        } catch {
          skippedAttachments++;
          skippedMissingDataBytes += inlineBytes;
          skipped.push({
            chatId: row.chat_id,
            sequence: row.sequence,
            toolName: toolResult.toolName,
            imageName: image.name,
            reason: hydrated.data ? "mismatched-file" : "persist-failed",
          });
          images.push(image);
        }
      }

      toolResults.push({ ...toolResult, images });
    }

    if (changed) {
      updates.push({
        chatId: row.chat_id,
        sequence: row.sequence,
        payloadJson: JSON.stringify({ ...message, toolResults }),
      });
    }
  }

  if (!dryRun && updates.length > 0) {
    const update = db.prepare(`
      UPDATE chat_message_rows
      SET payload_json = ?
      WHERE chat_id = ? AND sequence = ?
    `);
    const transaction = db.transaction((items: typeof updates) => {
      for (const item of items) update.run(item.payloadJson, item.chatId, item.sequence);
    });
    transaction(updates);
  }

  const after = dryRun ? before : inlineToolResultImageSummary(db);
  return {
    dryRun,
    scannedRows: rows.length,
    changedRows: updates.length,
    strippedAttachments,
    persistedAttachments,
    skippedAttachments,
    skippedMissingDataBytes,
    removedBase64Bytes,
    beforeInlineAttachments: before.count,
    beforeInlineBase64Bytes: before.totalBase64Bytes,
    afterInlineAttachments: after.count,
    afterInlineBase64Bytes: after.totalBase64Bytes,
    skipped: skipped.slice(0, 25),
  };
}
