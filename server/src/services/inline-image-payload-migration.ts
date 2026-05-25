import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import type { ChatMessage, ImageAttachment } from "../types.js";
import { getDb } from "./chat-storage.js";
import {
  hydrateUserImageAttachment,
  saveUserImage,
  stripImageAttachmentData,
} from "./user-image-storage.js";

export interface InlineImagePayloadMigrationOptions {
  dryRun?: boolean;
  limit?: number;
  persistMissing?: boolean;
}

export interface InlineImagePayloadMigrationResult {
  dryRun: boolean;
  scannedRows: number;
  changedRows: number;
  strippedAttachments: number;
  persistedMissingAttachments: number;
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
    imageName?: string;
    reason: "missing-storage" | "mismatched-file" | "persist-failed" | "invalid-message";
  }>;
}

interface InlineImageSummary {
  count: number;
  totalBase64Bytes: number;
}

interface InlineImageRow {
  chat_id: string;
  sequence: number;
  payload_json: string;
}

function inlineImageSummary(db: Database.Database): InlineImageSummary {
  return db.prepare(`
    SELECT
      COUNT(img.key) AS count,
      COALESCE(SUM(length(COALESCE(json_extract(img.value, '$.data'), ''))), 0) AS totalBase64Bytes
    FROM (
      SELECT payload_json
      FROM chat_message_rows
      WHERE json_valid(payload_json)
        AND json_type(payload_json, '$.images') = 'array'
    ) r
    JOIN json_each(r.payload_json, '$.images') img
    WHERE length(COALESCE(json_extract(img.value, '$.data'), '')) > 0
  `).get() as InlineImageSummary;
}

function inlineImageRows(db: Database.Database, limit?: number): InlineImageRow[] {
  const limitClause = limit && Number.isFinite(limit) && limit > 0 ? "LIMIT ?" : "";
  const sql = `
    SELECT DISTINCT r.chat_id, r.sequence, r.payload_json
    FROM chat_message_rows r
    JOIN json_each(r.payload_json, '$.images') img
    WHERE json_valid(r.payload_json)
      AND json_type(r.payload_json, '$.images') = 'array'
      AND length(COALESCE(json_extract(img.value, '$.data'), '')) > 0
    ORDER BY r.timestamp ASC, r.chat_id ASC, r.sequence ASC
    ${limitClause}
  `;
  return limitClause
    ? db.prepare(sql).all(limit) as InlineImageRow[]
    : db.prepare(sql).all() as InlineImageRow[];
}

function imageHasStoragePointer(image: ImageAttachment): boolean {
  return Boolean(image.id && image.url && image.thumbUrl);
}

async function persistMissingImage(image: ImageAttachment, preferredId?: string): Promise<ImageAttachment> {
  if (!image.data) throw new Error("image has no data");
  const id = preferredId || randomUUID();
  const record = await saveUserImage(
    id,
    Buffer.from(image.data, "base64"),
    image.mimeType,
    image.name,
  );
  return {
    mimeType: image.mimeType,
    name: image.name,
    id: record.id,
    url: record.url,
    thumbUrl: record.thumbUrl,
  };
}

export async function migrateInlineImagePayloads(
  options: InlineImagePayloadMigrationOptions = {},
): Promise<InlineImagePayloadMigrationResult> {
  const dryRun = options.dryRun !== false;
  const persistMissing = options.persistMissing !== false;
  const db = getDb();
  const before = inlineImageSummary(db);
  const rows = inlineImageRows(db, options.limit);
  const updates: Array<{ chatId: string; sequence: number; payloadJson: string }> = [];
  const skipped: InlineImagePayloadMigrationResult["skipped"] = [];

  let strippedAttachments = 0;
  let persistedMissingAttachments = 0;
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

    if (!Array.isArray(message.images)) continue;

    let changed = false;
    const images: ImageAttachment[] = [];

    for (const image of message.images) {
      const inlineBytes = image.data?.length ?? 0;
      if (!inlineBytes) {
        images.push(image);
        continue;
      }

      const stripped = stripImageAttachmentData(image);
      const hydrated = image.id ? await hydrateUserImageAttachment(stripped) : stripped;

      if (hydrated.data === image.data && imageHasStoragePointer(stripped)) {
        images.push(stripped);
        strippedAttachments++;
        removedBase64Bytes += inlineBytes;
        changed = true;
        continue;
      }

      if (persistMissing && (!hydrated.data || !imageHasStoragePointer(stripped))) {
        if (dryRun) {
          images.push(stripped);
          persistedMissingAttachments++;
          removedBase64Bytes += inlineBytes;
          changed = true;
          continue;
        }

        try {
          const persisted = await persistMissingImage(image, image.id);
          images.push(persisted);
          persistedMissingAttachments++;
          removedBase64Bytes += inlineBytes;
          changed = true;
          continue;
        } catch {
          skippedAttachments++;
          skippedMissingDataBytes += inlineBytes;
          skipped.push({
            chatId: row.chat_id,
            sequence: row.sequence,
            imageName: image.name,
            reason: "persist-failed",
          });
          images.push(image);
          continue;
        }
      }

      skippedAttachments++;
      skippedMissingDataBytes += inlineBytes;
      skipped.push({
        chatId: row.chat_id,
        sequence: row.sequence,
        imageName: image.name,
        reason: hydrated.data ? "mismatched-file" : "missing-storage",
      });
      images.push(image);
    }

    if (changed) {
      updates.push({
        chatId: row.chat_id,
        sequence: row.sequence,
        payloadJson: JSON.stringify({ ...message, images }),
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
      for (const item of items) {
        update.run(item.payloadJson, item.chatId, item.sequence);
      }
    });
    transaction(updates);
  }

  const after = dryRun ? before : inlineImageSummary(db);
  return {
    dryRun,
    scannedRows: rows.length,
    changedRows: updates.length,
    strippedAttachments,
    persistedMissingAttachments,
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
