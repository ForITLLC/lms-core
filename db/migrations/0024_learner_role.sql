-- forit-LMS — migration 0024: a new sign-in is a learner, and authors who
-- never authored anything become learners (task A3D29E12).
-- Until now every sign-in became an author, so every learner could open the
-- staff pages: course admin, assignments, the compliance export, API keys.
--
-- Demoted: Role='author' rows outside the ForIT tenant with no staff evidence
-- in their tenant (created, owned or published a course, assigned training,
-- or holds an API key). Admins, ForIT staff and anyone with that evidence keep
-- their role. Each demotion writes one lms.AuditEvent (Verb 'role.demote');
-- to undo, set Role='author' for the AppUserIds in those events.
-- Idempotent: a second run finds nobody left to demote.

IF NOT EXISTS (SELECT 1 FROM sys.default_constraints
                WHERE parent_object_id = OBJECT_ID('lms.AppUser')
                  AND name = 'DF_lms_AppUser_Role'
                  AND definition = '(''learner'')')
BEGIN
    IF EXISTS (SELECT 1 FROM sys.default_constraints
                WHERE parent_object_id = OBJECT_ID('lms.AppUser')
                  AND name = 'DF_lms_AppUser_Role')
        ALTER TABLE lms.AppUser DROP CONSTRAINT DF_lms_AppUser_Role;
    ALTER TABLE lms.AppUser
        ADD CONSTRAINT DF_lms_AppUser_Role DEFAULT ('learner') FOR Role;
END
GO

DECLARE @demoted TABLE (AppUserId UNIQUEIDENTIFIER, TenantId UNIQUEIDENTIFIER, Email NVARCHAR(320));

UPDATE u
   SET Role = 'learner'
OUTPUT inserted.AppUserId, inserted.TenantId, inserted.Email INTO @demoted
  FROM lms.AppUser u
  JOIN lms.Tenant t ON t.TenantId = u.TenantId
 WHERE u.Role = 'author'
   AND t.Slug <> 'forit'
   AND NOT EXISTS (SELECT 1 FROM lms.Course c
                    WHERE c.TenantId = u.TenantId
                      AND (c.CreatedBy = u.Email OR c.OwnerUserId = u.AppUserId))
   AND NOT EXISTS (SELECT 1 FROM lms.CourseVersion v
                     JOIN lms.Course c ON c.CourseId = v.CourseId
                    WHERE c.TenantId = u.TenantId AND v.PublishedBy = u.Email)
   AND NOT EXISTS (SELECT 1 FROM lms.CourseAssignment a
                    WHERE a.TenantId = u.TenantId AND a.AssignedBy = u.Email)
   AND NOT EXISTS (SELECT 1 FROM lms.ApiKey k
                    WHERE k.AppUserId = u.AppUserId);

INSERT INTO lms.AuditEvent (EventId, TenantId, Actor, Verb, ObjectKind, ObjectId, MetaJson)
SELECT NEWID(), d.TenantId, 'migration:0024_learner_role', 'role.demote', 'AppUser',
       CONVERT(varchar(64), d.AppUserId), N'{"from":"author","to":"learner"}'
  FROM @demoted d;

UPDATE k
   SET Role = 'learner'
  FROM lms.MobileDeviceKey k
  JOIN @demoted d ON d.TenantId = k.TenantId AND d.Email = k.Email
 WHERE k.Role = 'author';

GO
