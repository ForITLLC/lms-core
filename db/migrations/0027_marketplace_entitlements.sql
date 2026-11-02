-- 0027_marketplace_entitlements: lms.Entitlement, the seats one marketplace order
-- line buys (docs/contracts/marketplace-connection.md §3, §6).

IF COL_LENGTH('lms.Tenant', 'IsPublisher') IS NULL
    ALTER TABLE lms.Tenant ADD IsPublisher BIT NOT NULL
        CONSTRAINT DF_lms_Tenant_IsPublisher DEFAULT (0);
GO

IF OBJECT_ID('lms.Entitlement', 'U') IS NULL
    CREATE TABLE lms.Entitlement (
        EntitlementId UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_lms_Entitlement_Id DEFAULT (NEWID())
                                                CONSTRAINT PK_lms_Entitlement PRIMARY KEY,
        OrderLineId   NVARCHAR(128)    NOT NULL CONSTRAINT UQ_lms_Entitlement_OrderLine UNIQUE,
        TenantId      UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_lms_Entitlement_Tenant REFERENCES lms.Tenant(TenantId),
        CourseId      UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_lms_Entitlement_Course REFERENCES lms.Course(CourseId),
        VersionId     UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_lms_Entitlement_Version REFERENCES lms.CourseVersion(VersionId),
        Seats         INT              NOT NULL CONSTRAINT CK_lms_Entitlement_Seats CHECK (Seats >= 0),
        AccessUntil   DATE             NULL,
        Status        NVARCHAR(16)     NOT NULL CONSTRAINT DF_lms_Entitlement_Status DEFAULT ('active'),
        CreatedAt     DATETIME2(3)     NOT NULL CONSTRAINT DF_lms_Entitlement_Created DEFAULT (SYSUTCDATETIME()),
        UpdatedAt     DATETIME2(3)     NOT NULL CONSTRAINT DF_lms_Entitlement_Updated DEFAULT (SYSUTCDATETIME()),
        ClosedAt      DATETIME2(3)     NULL,
        CONSTRAINT CK_lms_Entitlement_Status
            CHECK (Status IN ('active', 'closed') AND (Status = 'active' OR Seats = 0))
    );
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes
                WHERE name = 'IX_lms_Entitlement_Tenant_Course'
                  AND object_id = OBJECT_ID('lms.Entitlement'))
    CREATE INDEX IX_lms_Entitlement_Tenant_Course
        ON lms.Entitlement (TenantId, CourseId, Status)
        INCLUDE (Seats, VersionId, AccessUntil);
GO

IF COL_LENGTH('lms.CourseAssignment', 'EntitlementId') IS NULL
    ALTER TABLE lms.CourseAssignment ADD EntitlementId UNIQUEIDENTIFIER NULL
        CONSTRAINT FK_lms_CourseAssignment_Entitlement REFERENCES lms.Entitlement(EntitlementId);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes
                WHERE name = 'IX_lms_CourseAssignment_Entitlement'
                  AND object_id = OBJECT_ID('lms.CourseAssignment'))
    CREATE INDEX IX_lms_CourseAssignment_Entitlement
        ON lms.CourseAssignment (EntitlementId);
GO
