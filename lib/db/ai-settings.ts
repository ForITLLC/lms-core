import { queryOne } from "@/lib/db";

// A tenant admin's AI choices (lms.TenantAiSetting, migration 0032). No row is
// every choice off.

export interface AiSettings {
  gradeWrittenAnswers: boolean;
  updatedBy: string | null;
  updatedAt: Date | null;
}

interface SettingRow {
  GradeWrittenAnswers: boolean | number;
  UpdatedBy: string;
  UpdatedAt: Date;
}

const OFF: AiSettings = { gradeWrittenAnswers: false, updatedBy: null, updatedAt: null };

function toSettings(row: SettingRow | null): AiSettings {
  if (!row) return OFF;
  return {
    gradeWrittenAnswers: row.GradeWrittenAnswers === true || row.GradeWrittenAnswers === 1,
    updatedBy: row.UpdatedBy,
    updatedAt: row.UpdatedAt,
  };
}

export async function getAiSettings(tenantId: string): Promise<AiSettings> {
  const row = await queryOne<SettingRow>(
    `SELECT GradeWrittenAnswers, UpdatedBy, UpdatedAt
       FROM lms.TenantAiSetting
      WHERE TenantId = @tenantId`,
    { tenantId },
  );
  return toSettings(row);
}

// The change and its audit event are one transaction, so no setting moves
// without a record of who moved it and from what.
export async function setAiSettings(
  tenantId: string,
  settings: { gradeWrittenAnswers: boolean },
  by: string,
): Promise<AiSettings> {
  const row = await queryOne<SettingRow>(
    `SET XACT_ABORT ON;
     BEGIN TRANSACTION;
     DECLARE @was bit;
     SELECT @was = GradeWrittenAnswers
       FROM lms.TenantAiSetting WITH (UPDLOCK, HOLDLOCK)
      WHERE TenantId = @tenantId;
     IF @was IS NULL
       INSERT INTO lms.TenantAiSetting (TenantId, GradeWrittenAnswers, UpdatedBy)
       VALUES (@tenantId, @grade, @by);
     ELSE
       UPDATE lms.TenantAiSetting
          SET GradeWrittenAnswers = @grade, UpdatedBy = @by, UpdatedAt = SYSUTCDATETIME()
        WHERE TenantId = @tenantId;
     INSERT INTO lms.AuditEvent (EventId, TenantId, Actor, Verb, ObjectKind, ObjectId, MetaJson)
     VALUES (NEWID(), @tenantId, @by, 'ai.settings.update', 'tenant', LOWER(CONVERT(varchar(36), @tenantId)),
             CONCAT('{"gradeWrittenAnswers":', CASE WHEN @grade = 1 THEN 'true' ELSE 'false' END,
                    ',"was":', CASE WHEN @was = 1 THEN 'true' ELSE 'false' END, '}'));
     COMMIT TRANSACTION;
     SELECT GradeWrittenAnswers, UpdatedBy, UpdatedAt
       FROM lms.TenantAiSetting
      WHERE TenantId = @tenantId;`,
    { tenantId, grade: settings.gradeWrittenAnswers, by },
  );
  return toSettings(row);
}
