-- forit-LMS — initial schema (lms.*)
-- Target: shared `forit` Azure SQL DB. Run as foritadmin.

IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'lms')
    EXEC('CREATE SCHEMA lms');
GO

CREATE TABLE lms.Tenant (
    TenantId        UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_lms_Tenant PRIMARY KEY,
    Slug            NVARCHAR(64)     NOT NULL,
    Name            NVARCHAR(256)    NOT NULL,
    AadTenantId     NVARCHAR(64)     NULL,
    DefaultLocale   NVARCHAR(16)     NOT NULL CONSTRAINT DF_lms_Tenant_Locale DEFAULT ('en-US'),
    AISettingsJson  NVARCHAR(MAX)    NULL,
    CustomHostname     NVARCHAR(256) NULL,
    DnsProvisionedAt   DATETIME2(3)  NULL,
    IsActive        BIT              NOT NULL CONSTRAINT DF_lms_Tenant_Active DEFAULT (1),
    CreatedAt       DATETIME2(3)     NOT NULL CONSTRAINT DF_lms_Tenant_Created DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT UQ_lms_Tenant_Slug UNIQUE (Slug)
);
GO

CREATE TABLE lms.TenantDomain (
    TenantDomainId UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_lms_TenantDomain PRIMARY KEY,
    TenantId       UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_lms_TenantDomain_Tenant REFERENCES lms.Tenant(TenantId),
    Domain         NVARCHAR(256)    NOT NULL,
    CONSTRAINT UQ_lms_TenantDomain UNIQUE (Domain)
);
GO

CREATE TABLE lms.AppUser (
    AppUserId   UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_lms_AppUser PRIMARY KEY,
    TenantId    UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_lms_AppUser_Tenant REFERENCES lms.Tenant(TenantId),
    Email       NVARCHAR(320)    NOT NULL,
    DisplayName NVARCHAR(256)    NOT NULL,
    AzureOid    NVARCHAR(64)     NULL,
    Role        NVARCHAR(32)     NOT NULL CONSTRAINT DF_lms_AppUser_Role DEFAULT ('author'),
    LastSeenAt  DATETIME2(3)     NULL,
    CreatedAt   DATETIME2(3)     NOT NULL CONSTRAINT DF_lms_AppUser_Created DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT UQ_lms_AppUser_TenantEmail UNIQUE (TenantId, Email)
);
GO

CREATE TABLE lms.Learner (
    LearnerId    UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_lms_Learner PRIMARY KEY,
    TenantId     UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_lms_Learner_Tenant REFERENCES lms.Tenant(TenantId),
    Email        NVARCHAR(320)    NOT NULL,
    DisplayName  NVARCHAR(256)    NOT NULL,
    ExternalRef  NVARCHAR(256)    NULL,
    Status       NVARCHAR(32)     NOT NULL CONSTRAINT DF_lms_Learner_Status DEFAULT ('active'),
    CreatedAt    DATETIME2(3)     NOT NULL CONSTRAINT DF_lms_Learner_Created DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT UQ_lms_Learner_TenantEmail UNIQUE (TenantId, Email)
);
GO

CREATE TABLE lms.Course (
    CourseId    UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_lms_Course PRIMARY KEY,
    TenantId    UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_lms_Course_Tenant REFERENCES lms.Tenant(TenantId),
    Title       NVARCHAR(256)    NOT NULL,
    Slug        NVARCHAR(128)    NOT NULL,
    Description NVARCHAR(MAX)    NULL,
    Status      NVARCHAR(32)     NOT NULL CONSTRAINT DF_lms_Course_Status DEFAULT ('draft'),
    CreatedBy   NVARCHAR(256)    NOT NULL,
    CreatedAt   DATETIME2(3)     NOT NULL CONSTRAINT DF_lms_Course_Created DEFAULT (SYSUTCDATETIME()),
    UpdatedAt   DATETIME2(3)     NOT NULL CONSTRAINT DF_lms_Course_Updated DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT UQ_lms_Course_TenantSlug UNIQUE (TenantId, Slug)
);
GO

CREATE TABLE lms.Lesson (
    LessonId    UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_lms_Lesson PRIMARY KEY,
    CourseId    UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_lms_Lesson_Course REFERENCES lms.Course(CourseId) ON DELETE CASCADE,
    Title       NVARCHAR(256)    NOT NULL,
    OrderIndex  INT              NOT NULL,
    EstMinutes  INT              NULL,
    CONSTRAINT UQ_lms_Lesson_CourseOrder UNIQUE (CourseId, OrderIndex)
);
GO

CREATE TABLE lms.Block (
    BlockId     UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_lms_Block PRIMARY KEY,
    LessonId    UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_lms_Block_Lesson REFERENCES lms.Lesson(LessonId) ON DELETE CASCADE,
    Kind        NVARCHAR(32)     NOT NULL,
    OrderIndex  INT              NOT NULL,
    PayloadJson NVARCHAR(MAX)    NOT NULL,
    CONSTRAINT UQ_lms_Block_LessonOrder UNIQUE (LessonId, OrderIndex)
);
GO

CREATE TABLE lms.Quiz (
    QuizId        UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_lms_Quiz PRIMARY KEY,
    BlockId       UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_lms_Quiz_Block REFERENCES lms.Block(BlockId) ON DELETE CASCADE,
    PassingScore  INT              NOT NULL CONSTRAINT DF_lms_Quiz_Pass DEFAULT (70)
);
GO

CREATE TABLE lms.QuizQuestion (
    QuestionId  UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_lms_QuizQuestion PRIMARY KEY,
    QuizId      UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_lms_QuizQ_Quiz REFERENCES lms.Quiz(QuizId) ON DELETE CASCADE,
    Kind        NVARCHAR(32)     NOT NULL,
    OrderIndex  INT              NOT NULL,
    PromptMd    NVARCHAR(MAX)    NOT NULL,
    PayloadJson NVARCHAR(MAX)    NOT NULL,
    CONSTRAINT UQ_lms_QuizQ_QuizOrder UNIQUE (QuizId, OrderIndex)
);
GO

CREATE TABLE lms.Enrollment (
    EnrollmentId UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_lms_Enrollment PRIMARY KEY,
    TenantId     UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_lms_Enrollment_Tenant REFERENCES lms.Tenant(TenantId),
    LearnerId    UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_lms_Enrollment_Learner REFERENCES lms.Learner(LearnerId),
    CourseId     UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_lms_Enrollment_Course REFERENCES lms.Course(CourseId),
    Status       NVARCHAR(32)     NOT NULL CONSTRAINT DF_lms_Enrollment_Status DEFAULT ('active'),
    EnrolledAt   DATETIME2(3)     NOT NULL CONSTRAINT DF_lms_Enrollment_Enrolled DEFAULT (SYSUTCDATETIME()),
    CompletedAt  DATETIME2(3)     NULL,
    CONSTRAINT UQ_lms_Enrollment_LearnerCourse UNIQUE (LearnerId, CourseId)
);
GO

CREATE TABLE lms.Progress (
    LearnerId   UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_lms_Progress_Learner REFERENCES lms.Learner(LearnerId),
    BlockId     UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_lms_Progress_Block REFERENCES lms.Block(BlockId),
    CompletedAt DATETIME2(3)     NOT NULL CONSTRAINT DF_lms_Progress_Completed DEFAULT (SYSUTCDATETIME()),
    Seconds     INT              NOT NULL CONSTRAINT DF_lms_Progress_Seconds DEFAULT (0),
    CONSTRAINT PK_lms_Progress PRIMARY KEY (LearnerId, BlockId)
);
GO

CREATE TABLE lms.QuizAttempt (
    AttemptId             UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_lms_QuizAttempt PRIMARY KEY,
    QuizId                UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_lms_QuizAttempt_Quiz REFERENCES lms.Quiz(QuizId),
    LearnerId             UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_lms_QuizAttempt_Learner REFERENCES lms.Learner(LearnerId),
    Score                 INT              NULL,
    ConfidenceCalibration DECIMAL(5,2)     NULL,
    StartedAt             DATETIME2(3)     NOT NULL CONSTRAINT DF_lms_QuizAttempt_Started DEFAULT (SYSUTCDATETIME()),
    SubmittedAt           DATETIME2(3)     NULL
);
GO

CREATE TABLE lms.AnswerResponse (
    AttemptId        UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_lms_AnswerResponse_Attempt REFERENCES lms.QuizAttempt(AttemptId) ON DELETE CASCADE,
    QuestionId       UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_lms_AnswerResponse_Question REFERENCES lms.QuizQuestion(QuestionId),
    ResponseJson     NVARCHAR(MAX)    NOT NULL,
    MachineScore     INT              NULL,
    RubricFeedbackMd NVARCHAR(MAX)    NULL,
    CONSTRAINT PK_lms_AnswerResponse PRIMARY KEY (AttemptId, QuestionId)
);
GO

CREATE TABLE lms.AssetIngestion (
    IngestionId    UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_lms_AssetIngestion PRIMARY KEY,
    TenantId       UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_lms_AssetIngestion_Tenant REFERENCES lms.Tenant(TenantId),
    SourceKind     NVARCHAR(32)     NOT NULL,
    SourceRef      NVARCHAR(2048)   NOT NULL,
    Status         NVARCHAR(32)     NOT NULL CONSTRAINT DF_lms_AssetIngestion_Status DEFAULT ('queued'),
    ResultCourseId UNIQUEIDENTIFIER NULL CONSTRAINT FK_lms_AssetIngestion_Course REFERENCES lms.Course(CourseId),
    ErrorMessage   NVARCHAR(MAX)    NULL,
    CreatedAt      DATETIME2(3)     NOT NULL CONSTRAINT DF_lms_AssetIngestion_Created DEFAULT (SYSUTCDATETIME())
);
GO

CREATE TABLE lms.AIConversation (
    ConversationId UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_lms_AIConversation PRIMARY KEY,
    TenantId       UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_lms_AIConversation_Tenant REFERENCES lms.Tenant(TenantId),
    LearnerId      UNIQUEIDENTIFIER NULL CONSTRAINT FK_lms_AIConversation_Learner REFERENCES lms.Learner(LearnerId),
    AppUserId      UNIQUEIDENTIFIER NULL CONSTRAINT FK_lms_AIConversation_AppUser REFERENCES lms.AppUser(AppUserId),
    CourseId       UNIQUEIDENTIFIER NULL CONSTRAINT FK_lms_AIConversation_Course REFERENCES lms.Course(CourseId),
    LessonId       UNIQUEIDENTIFIER NULL CONSTRAINT FK_lms_AIConversation_Lesson REFERENCES lms.Lesson(LessonId),
    Kind           NVARCHAR(32)     NOT NULL,
    CreatedAt      DATETIME2(3)     NOT NULL CONSTRAINT DF_lms_AIConversation_Created DEFAULT (SYSUTCDATETIME()),
    UpdatedAt     DATETIME2(3)      NOT NULL CONSTRAINT DF_lms_AIConversation_Updated DEFAULT (SYSUTCDATETIME())
);
GO

CREATE TABLE lms.AIMessage (
    MessageId       UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_lms_AIMessage PRIMARY KEY,
    ConversationId  UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_lms_AIMessage_Conversation REFERENCES lms.AIConversation(ConversationId) ON DELETE CASCADE,
    Role            NVARCHAR(16)     NOT NULL,
    ContentJson     NVARCHAR(MAX)    NOT NULL,
    Model           NVARCHAR(64)     NULL,
    InputTokens     INT              NULL,
    OutputTokens    INT              NULL,
    CacheReadTokens INT              NULL,
    CreatedAt       DATETIME2(3)     NOT NULL CONSTRAINT DF_lms_AIMessage_Created DEFAULT (SYSUTCDATETIME())
);
GO

CREATE TABLE lms.AuditEvent (
    EventId    UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_lms_AuditEvent PRIMARY KEY,
    TenantId   UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_lms_AuditEvent_Tenant REFERENCES lms.Tenant(TenantId),
    Actor      NVARCHAR(256)    NOT NULL,
    Verb       NVARCHAR(64)     NOT NULL,
    ObjectKind NVARCHAR(64)     NOT NULL,
    ObjectId   NVARCHAR(128)    NULL,
    At         DATETIME2(3)     NOT NULL CONSTRAINT DF_lms_AuditEvent_At DEFAULT (SYSUTCDATETIME()),
    MetaJson   NVARCHAR(MAX)    NULL
);
GO

CREATE TABLE lms.TenantBranding (
    TenantId               UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_lms_TenantBranding PRIMARY KEY
                              CONSTRAINT FK_lms_TenantBranding_Tenant REFERENCES lms.Tenant(TenantId) ON DELETE CASCADE,
    CompanyName            NVARCHAR(256)    NULL,
    LogoUrl                NVARCHAR(2048)   NULL,
    LogoWhiteUrl           NVARCHAR(2048)   NULL,
    FaviconUrl             NVARCHAR(2048)   NULL,
    PrimaryColor           NVARCHAR(16)     NULL,
    SecondaryColor         NVARCHAR(16)     NULL,
    AccentColor            NVARCHAR(16)     NULL,
    FontFamily             NVARCHAR(256)    NULL,
    SupportEmail           NVARCHAR(320)    NULL,
    SupportPhone           NVARCHAR(64)     NULL,
    WelcomeText            NVARCHAR(MAX)    NULL,
    PortalWelcomeText      NVARCHAR(MAX)    NULL,
    CustomCss              NVARCHAR(MAX)    NULL,
    EmailSenderAddress     NVARCHAR(320)    NULL,
    EmailSenderDisplayName NVARCHAR(256)    NULL,
    SettingsJson           NVARCHAR(MAX)    NULL,
    UpdatedAt              DATETIME2(3)     NOT NULL CONSTRAINT DF_lms_TenantBranding_Updated DEFAULT (SYSUTCDATETIME())
);
GO

CREATE INDEX IX_lms_Course_Tenant ON lms.Course(TenantId, Status);
CREATE INDEX IX_lms_Enrollment_Learner ON lms.Enrollment(LearnerId, Status);
CREATE INDEX IX_lms_AuditEvent_Tenant_At ON lms.AuditEvent(TenantId, At DESC);
CREATE INDEX IX_lms_AIConversation_Tenant ON lms.AIConversation(TenantId, UpdatedAt DESC);
GO
