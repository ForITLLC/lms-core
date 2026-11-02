IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID('lms.AppUser') AND name = 'UX_lms_AppUser_Tenant_Id')
  CREATE UNIQUE INDEX UX_lms_AppUser_Tenant_Id ON lms.AppUser(TenantId, AppUserId);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID('lms.Learner') AND name = 'UX_lms_Learner_Tenant_Id')
  CREATE UNIQUE INDEX UX_lms_Learner_Tenant_Id ON lms.Learner(TenantId, LearnerId);
GO

IF OBJECT_ID('lms.LearnerManager', 'U') IS NULL
BEGIN
  CREATE TABLE lms.LearnerManager (
    TenantId UNIQUEIDENTIFIER NOT NULL REFERENCES lms.Tenant(TenantId),
    ManagerAppUserId UNIQUEIDENTIFIER NOT NULL,
    LearnerId UNIQUEIDENTIFIER NOT NULL,
    CreatedAt DATETIME2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
    CreatedBy NVARCHAR(320) NOT NULL,
    CONSTRAINT PK_lms_LearnerManager PRIMARY KEY (TenantId, ManagerAppUserId, LearnerId),
    CONSTRAINT FK_lms_LearnerManager_Manager FOREIGN KEY (TenantId, ManagerAppUserId) REFERENCES lms.AppUser(TenantId, AppUserId),
    CONSTRAINT FK_lms_LearnerManager_Learner FOREIGN KEY (TenantId, LearnerId) REFERENCES lms.Learner(TenantId, LearnerId)
  );
END
GO

IF OBJECT_ID('lms.DigestDelivery', 'U') IS NULL
BEGIN
  CREATE TABLE lms.DigestDelivery (
    TenantId UNIQUEIDENTIFIER NOT NULL REFERENCES lms.Tenant(TenantId),
    RecipientEmail NVARCHAR(320) NOT NULL,
    DigestDay DATE NOT NULL,
    ClaimId UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
    Status NVARCHAR(16) NOT NULL CONSTRAINT CK_lms_DigestDelivery_Status CHECK (Status IN ('claimed', 'sent', 'uncertain')),
    WindowStart DATETIME2(3) NOT NULL,
    WindowEnd DATETIME2(3) NOT NULL,
    ClaimedAt DATETIME2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
    SentAt DATETIME2(3) NULL,
    Error NVARCHAR(2048) NULL,
    CONSTRAINT PK_lms_DigestDelivery PRIMARY KEY (TenantId, RecipientEmail, DigestDay),
    CONSTRAINT UQ_lms_DigestDelivery_Claim UNIQUE (ClaimId)
  );
END
GO
