-- ============================================================
-- AI Call System — Full Database Setup
-- Target:  DevDatabase_Staging  (SQL Server 2016+)
-- Table naming convention:  ai_call_system_<table>
-- SP naming convention:     sp_<action>_Ai_call_system
--
-- Run via:  node src/database/runSetup.js
-- Safe to re-run — drops and recreates all objects.
-- ============================================================

USE DevDatabase_Staging;
GO

-- ============================================================
-- CLEANUP: Drop old suffix-named tables if they exist
-- ============================================================
IF OBJECT_ID('callback_queue_Ai_call_system',     'U') IS NOT NULL DROP TABLE callback_queue_Ai_call_system;
IF OBJECT_ID('communication_logs_Ai_call_system', 'U') IS NOT NULL DROP TABLE communication_logs_Ai_call_system;
IF OBJECT_ID('tbl_caller_registry_Ai_call_system','U') IS NOT NULL DROP TABLE tbl_caller_registry_Ai_call_system;
IF OBJECT_ID('call_master_Ai_call_system',         'U') IS NOT NULL DROP TABLE call_master_Ai_call_system;
IF OBJECT_ID('call_logs_Ai_call_system',           'U') IS NOT NULL DROP TABLE call_logs_Ai_call_system;
PRINT 'Cleanup: old tables dropped (if they existed)';
GO

-- ============================================================
-- TABLE 1: ai_call_system_call_master
-- One row per call. TopicsJSON updated progressively during
-- the call by Vapi tool calls. CallSummary written at call end.
-- ============================================================
IF OBJECT_ID('ai_call_system_call_master', 'U') IS NOT NULL
    DROP TABLE ai_call_system_call_master;
GO

CREATE TABLE ai_call_system_call_master (
    CallID          BIGINT        IDENTITY(1,1) NOT NULL,
    TwilioCallSID   VARCHAR(50)   NOT NULL,
    VapiCallID      VARCHAR(100)  NULL,
    CallerPhone     VARCHAR(20)   NOT NULL,
    CalledPhone     VARCHAR(20)   NOT NULL,
    Direction       VARCHAR(10)   NOT NULL CONSTRAINT DF_CM_Direction    DEFAULT 'inbound',
    CallerStatus    VARCHAR(25)   NOT NULL CONSTRAINT DF_CM_CallerStatus DEFAULT 'unknown',
    AgentID         VARCHAR(50)   NULL,
    CallerName      VARCHAR(100)  NULL,
    CallerEmail     VARCHAR(150)  NULL,
    CallStatus      VARCHAR(20)   NOT NULL CONSTRAINT DF_CM_CallStatus   DEFAULT 'in_progress',
    CallStartedAt   DATETIME      NOT NULL CONSTRAINT DF_CM_CallStarted  DEFAULT GETDATE(),
    CallEndedAt     DATETIME      NULL,
    DurationSecs    INT           NULL,
    RecordingSID    VARCHAR(50)   NULL,
    RecordingURL    VARCHAR(500)  NULL,
    RoutedTo        VARCHAR(50)   NULL,
    RoutingReason   NVARCHAR(300) NULL,
    TopicsJSON      NVARCHAR(MAX) NULL,
    CallSummary     NVARCHAR(MAX) NULL,
    IsResolved      BIT           NOT NULL CONSTRAINT DF_CM_IsResolved   DEFAULT 0,
    CreatedAt       DATETIME      NOT NULL CONSTRAINT DF_CM_CreatedAt    DEFAULT GETDATE(),
    UpdatedAt       DATETIME      NOT NULL CONSTRAINT DF_CM_UpdatedAt    DEFAULT GETDATE(),

    CONSTRAINT PK_CallMaster           PRIMARY KEY CLUSTERED (CallID ASC),
    CONSTRAINT UQ_CallMaster_TwilioSID UNIQUE (TwilioCallSID)
);
GO

CREATE NONCLUSTERED INDEX IX_CM_CallerPhone  ON ai_call_system_call_master (CallerPhone ASC);
CREATE NONCLUSTERED INDEX IX_CM_AgentID      ON ai_call_system_call_master (AgentID ASC) WHERE AgentID IS NOT NULL;
CREATE NONCLUSTERED INDEX IX_CM_StartedAt    ON ai_call_system_call_master (CallStartedAt DESC);
PRINT 'TABLE created: ai_call_system_call_master';
GO

-- ============================================================
-- TABLE 2: ai_call_system_caller_registry
-- One row per phone number. Multiple phones can link to one
-- AgentID (agent using different numbers).
-- ============================================================
IF OBJECT_ID('ai_call_system_caller_registry', 'U') IS NOT NULL
    DROP TABLE ai_call_system_caller_registry;
GO

CREATE TABLE ai_call_system_caller_registry (
    RegistryID    INT          IDENTITY(1,1) NOT NULL,
    PhoneNumber   VARCHAR(20)  NOT NULL,
    AgentID       VARCHAR(50)  NULL,
    CallerName    VARCHAR(100) NULL,
    CallerEmail   VARCHAR(150) NULL,
    CustomerType  VARCHAR(20)  NOT NULL CONSTRAINT DF_CR_CustomerType DEFAULT 'unknown',
    IsVerified    BIT          NOT NULL CONSTRAINT DF_CR_IsVerified   DEFAULT 0,
    VerifyMethod  VARCHAR(20)  NULL,
    VerifiedAt    DATETIME     NULL,
    FirstSeenAt   DATETIME     NOT NULL CONSTRAINT DF_CR_FirstSeen    DEFAULT GETDATE(),
    LastSeenAt    DATETIME     NOT NULL CONSTRAINT DF_CR_LastSeen     DEFAULT GETDATE(),
    TotalCalls    INT          NOT NULL CONSTRAINT DF_CR_TotalCalls   DEFAULT 0,
    IsActive      BIT          NOT NULL CONSTRAINT DF_CR_IsActive     DEFAULT 1,
    Notes         VARCHAR(500) NULL,

    CONSTRAINT PK_CallerRegistry       PRIMARY KEY CLUSTERED (RegistryID ASC),
    CONSTRAINT UQ_CallerRegistry_Phone UNIQUE (PhoneNumber)
);
GO

CREATE NONCLUSTERED INDEX IX_CR_AgentID ON ai_call_system_caller_registry (AgentID ASC) WHERE AgentID IS NOT NULL;
PRINT 'TABLE created: ai_call_system_caller_registry';
GO

-- ============================================================
-- TABLE 3: ai_call_system_comm_logs
-- Every outbound email / SMS / WhatsApp message.
-- ============================================================
IF OBJECT_ID('ai_call_system_comm_logs', 'U') IS NOT NULL
    DROP TABLE ai_call_system_comm_logs;
GO

CREATE TABLE ai_call_system_comm_logs (
    LogID          BIGINT        IDENTITY(1,1) NOT NULL,
    CallID         BIGINT        NULL,
    Channel        VARCHAR(20)   NOT NULL,
    RecipientPhone VARCHAR(20)   NULL,
    RecipientEmail VARCHAR(200)  NULL,
    Subject        NVARCHAR(300) NULL,
    Body           NVARCHAR(MAX) NULL,
    TwilioMsgSID   VARCHAR(50)   NULL,
    Status         VARCHAR(20)   NOT NULL CONSTRAINT DF_CL_Status DEFAULT 'sent',
    SentAt         DATETIME      NOT NULL CONSTRAINT DF_CL_SentAt DEFAULT GETDATE(),

    CONSTRAINT PK_CommLogs PRIMARY KEY CLUSTERED (LogID ASC)
);
GO

CREATE NONCLUSTERED INDEX IX_CL_CallID ON ai_call_system_comm_logs (CallID ASC) WHERE CallID IS NOT NULL;
PRINT 'TABLE created: ai_call_system_comm_logs';
GO

-- ============================================================
-- TABLE 4: ai_call_system_callback_queue
-- Pending callback requests ordered by priority then age.
-- ============================================================
IF OBJECT_ID('ai_call_system_callback_queue', 'U') IS NOT NULL
    DROP TABLE ai_call_system_callback_queue;
GO

CREATE TABLE ai_call_system_callback_queue (
    QueueID     BIGINT        IDENTITY(1,1) NOT NULL,
    Phone       VARCHAR(20)   NOT NULL,
    CallID      BIGINT        NULL,
    Reason      NVARCHAR(500) NULL,
    Department  VARCHAR(20)   NOT NULL CONSTRAINT DF_CB_Department DEFAULT 'sales',
    Priority    INT           NOT NULL CONSTRAINT DF_CB_Priority   DEFAULT 1,
    Status      VARCHAR(20)   NOT NULL CONSTRAINT DF_CB_Status     DEFAULT 'pending',
    ScheduledAt DATETIME      NOT NULL CONSTRAINT DF_CB_Scheduled  DEFAULT GETDATE(),
    CalledAt    DATETIME      NULL,
    Notes       NVARCHAR(300) NULL,

    CONSTRAINT PK_CallbackQueue PRIMARY KEY CLUSTERED (QueueID ASC)
);
GO

CREATE NONCLUSTERED INDEX IX_CB_Status ON ai_call_system_callback_queue (Status ASC, Priority DESC, ScheduledAt ASC);
PRINT 'TABLE created: ai_call_system_callback_queue';
GO

-- ============================================================
-- SP 1: sp_InsertCallMaster_Ai_call_system
-- Called by Twilio inbound webhook. Returns new CallID.
-- Idempotent: returns existing CallID on duplicate SID (Twilio retry).
-- ============================================================
IF OBJECT_ID('sp_InsertCallMaster_Ai_call_system', 'P') IS NOT NULL
    DROP PROCEDURE sp_InsertCallMaster_Ai_call_system;
GO
CREATE PROCEDURE sp_InsertCallMaster_Ai_call_system
(
    @twilio_call_sid VARCHAR(50),
    @caller_phone    VARCHAR(20),
    @called_phone    VARCHAR(20),
    @direction       VARCHAR(10)  = 'inbound',
    @vapi_call_id    VARCHAR(100) = NULL
)
AS
BEGIN
    SET NOCOUNT ON;

    IF EXISTS (SELECT 1 FROM ai_call_system_call_master WHERE TwilioCallSID = @twilio_call_sid)
    BEGIN
        SELECT CallID FROM ai_call_system_call_master WHERE TwilioCallSID = @twilio_call_sid;
        RETURN;
    END

    INSERT INTO ai_call_system_call_master
        (TwilioCallSID, VapiCallID, CallerPhone, CalledPhone, Direction)
    VALUES
        (@twilio_call_sid, @vapi_call_id, @caller_phone, @called_phone, @direction);
    SELECT SCOPE_IDENTITY() AS CallID;
END
GO
PRINT 'SP created: sp_InsertCallMaster_Ai_call_system';
GO

-- ============================================================
-- SP 2: sp_UpdateCallMaster_Ai_call_system
-- Partial update — only non-NULL params are written.
-- Includes recording fields so recording webhook does not need
-- to call closeCallMaster.
-- ============================================================
IF OBJECT_ID('sp_UpdateCallMaster_Ai_call_system', 'P') IS NOT NULL
    DROP PROCEDURE sp_UpdateCallMaster_Ai_call_system;
GO
CREATE PROCEDURE sp_UpdateCallMaster_Ai_call_system
(
    @twilio_call_sid VARCHAR(50),
    @caller_status   VARCHAR(25)   = NULL,
    @agent_id        VARCHAR(50)   = NULL,
    @caller_name     VARCHAR(100)  = NULL,
    @caller_email    VARCHAR(150)  = NULL,
    @call_status     VARCHAR(20)   = NULL,
    @vapi_call_id    VARCHAR(100)  = NULL,
    @routed_to       VARCHAR(50)   = NULL,
    @routing_reason  NVARCHAR(300) = NULL,
    @is_resolved     BIT           = NULL,
    @recording_sid   VARCHAR(50)   = NULL,
    @recording_url   VARCHAR(500)  = NULL
)
AS
BEGIN
    SET NOCOUNT ON;
    UPDATE ai_call_system_call_master SET
        CallerStatus  = ISNULL(@caller_status,  CallerStatus),
        AgentID       = ISNULL(@agent_id,        AgentID),
        CallerName    = ISNULL(@caller_name,     CallerName),
        CallerEmail   = ISNULL(@caller_email,    CallerEmail),
        CallStatus    = ISNULL(@call_status,     CallStatus),
        VapiCallID    = ISNULL(@vapi_call_id,    VapiCallID),
        RoutedTo      = ISNULL(@routed_to,       RoutedTo),
        RoutingReason = ISNULL(@routing_reason,  RoutingReason),
        IsResolved    = ISNULL(@is_resolved,     IsResolved),
        RecordingSID  = ISNULL(@recording_sid,   RecordingSID),
        RecordingURL  = ISNULL(@recording_url,   RecordingURL),
        UpdatedAt     = GETDATE()
    WHERE TwilioCallSID = @twilio_call_sid;
    SELECT @@ROWCOUNT AS RowsAffected;
END
GO
PRINT 'SP created: sp_UpdateCallMaster_Ai_call_system';
GO

-- ============================================================
-- SP 3: sp_UpdateCallTopic_Ai_call_system  *** KEY SP ***
-- Appends a JSON object to a named topic array inside
-- TopicsJSON. Called by Vapi DURING the call after each event.
-- Each topic is an array: { "new_booking": [{...},{...}], ... }
-- ============================================================
IF OBJECT_ID('sp_UpdateCallTopic_Ai_call_system', 'P') IS NOT NULL
    DROP PROCEDURE sp_UpdateCallTopic_Ai_call_system;
GO
CREATE PROCEDURE sp_UpdateCallTopic_Ai_call_system
(
    @twilio_call_sid VARCHAR(50),
    @topic_name      VARCHAR(50),
    @topic_entry     NVARCHAR(MAX)  -- valid JSON object, e.g. {"destination":"Dubai","pax":10}
)
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @existing_json  NVARCHAR(MAX);
    DECLARE @existing_array NVARCHAR(MAX);
    DECLARE @new_json       NVARCHAR(MAX);
    DECLARE @json_path      NVARCHAR(100);

    SET @json_path = '$.' + @topic_name;

    BEGIN TRANSACTION;

    -- UPDLOCK serialises concurrent topic appends for the same call row
    SELECT @existing_json = TopicsJSON
    FROM   ai_call_system_call_master WITH (UPDLOCK, ROWLOCK)
    WHERE  TwilioCallSID = @twilio_call_sid;

    IF @@ROWCOUNT = 0
    BEGIN
        ROLLBACK TRANSACTION;
        SELECT 0 AS RowsAffected;
        RETURN;
    END

    IF @existing_json IS NULL SET @existing_json = '{}';

    SET @existing_array = JSON_QUERY(@existing_json, @json_path);

    IF @existing_array IS NULL
    BEGIN
        SET @new_json = JSON_MODIFY(@existing_json, @json_path, JSON_QUERY('[' + @topic_entry + ']'));
    END
    ELSE
    BEGIN
        DECLARE @trimmed NVARCHAR(MAX);
        SET @trimmed  = LEFT(RTRIM(@existing_array), LEN(RTRIM(@existing_array)) - 1);
        SET @new_json = JSON_MODIFY(@existing_json, @json_path, JSON_QUERY(@trimmed + ',' + @topic_entry + ']'));
    END

    UPDATE ai_call_system_call_master SET
        TopicsJSON = @new_json,
        UpdatedAt  = GETDATE()
    WHERE TwilioCallSID = @twilio_call_sid;

    COMMIT TRANSACTION;
    SELECT @@ROWCOUNT AS RowsAffected;
END
GO
PRINT 'SP created: sp_UpdateCallTopic_Ai_call_system';
GO

-- ============================================================
-- SP 4: sp_CloseCallMaster_Ai_call_system
-- Called by Twilio status-callback on call end.
-- CallEndedAt only set when NULL — idempotent on re-calls.
-- @call_status defaults to NULL (ISNULL keeps existing value).
-- ============================================================
IF OBJECT_ID('sp_CloseCallMaster_Ai_call_system', 'P') IS NOT NULL
    DROP PROCEDURE sp_CloseCallMaster_Ai_call_system;
GO
CREATE PROCEDURE sp_CloseCallMaster_Ai_call_system
(
    @twilio_call_sid VARCHAR(50),
    @duration_secs   INT           = NULL,
    @recording_sid   VARCHAR(50)   = NULL,
    @recording_url   VARCHAR(500)  = NULL,
    @call_summary    NVARCHAR(MAX) = NULL,
    @call_status     VARCHAR(20)   = NULL,
    @is_resolved     BIT           = NULL
)
AS
BEGIN
    SET NOCOUNT ON;
    UPDATE ai_call_system_call_master SET
        CallEndedAt  = CASE WHEN CallEndedAt IS NULL THEN GETDATE() ELSE CallEndedAt END,
        DurationSecs = ISNULL(@duration_secs, DurationSecs),
        RecordingSID = ISNULL(@recording_sid, RecordingSID),
        RecordingURL = ISNULL(@recording_url, RecordingURL),
        CallSummary  = ISNULL(@call_summary,  CallSummary),
        CallStatus   = ISNULL(@call_status,   CallStatus),
        IsResolved   = ISNULL(@is_resolved,   IsResolved),
        UpdatedAt    = GETDATE()
    WHERE TwilioCallSID = @twilio_call_sid;
    SELECT @@ROWCOUNT AS RowsAffected;
END
GO
PRINT 'SP created: sp_CloseCallMaster_Ai_call_system';
GO

-- ============================================================
-- SP 5: sp_GetCallByTwilioSID_Ai_call_system
-- ============================================================
IF OBJECT_ID('sp_GetCallByTwilioSID_Ai_call_system', 'P') IS NOT NULL
    DROP PROCEDURE sp_GetCallByTwilioSID_Ai_call_system;
GO
CREATE PROCEDURE sp_GetCallByTwilioSID_Ai_call_system
(
    @twilio_call_sid VARCHAR(50)
)
AS
BEGIN
    SET NOCOUNT ON;
    SELECT * FROM ai_call_system_call_master WHERE TwilioCallSID = @twilio_call_sid;
END
GO
PRINT 'SP created: sp_GetCallByTwilioSID_Ai_call_system';
GO

-- ============================================================
-- SP 6: sp_GetCallerByPhone_Ai_call_system
-- ============================================================
IF OBJECT_ID('sp_GetCallerByPhone_Ai_call_system', 'P') IS NOT NULL
    DROP PROCEDURE sp_GetCallerByPhone_Ai_call_system;
GO
CREATE PROCEDURE sp_GetCallerByPhone_Ai_call_system
(
    @phone VARCHAR(20)
)
AS
BEGIN
    SET NOCOUNT ON;
    SELECT * FROM ai_call_system_caller_registry WHERE PhoneNumber = @phone;
END
GO
PRINT 'SP created: sp_GetCallerByPhone_Ai_call_system';
GO

-- ============================================================
-- SP 7: sp_InsertCallerRegistry_Ai_call_system
-- Guard: only inserts when phone not already present.
-- Returns RegistryID (new or existing).
-- ============================================================
IF OBJECT_ID('sp_InsertCallerRegistry_Ai_call_system', 'P') IS NOT NULL
    DROP PROCEDURE sp_InsertCallerRegistry_Ai_call_system;
GO
CREATE PROCEDURE sp_InsertCallerRegistry_Ai_call_system
(
    @phone          VARCHAR(20),
    @agent_id       VARCHAR(50)  = NULL,
    @caller_name    VARCHAR(100) = NULL,
    @caller_email   VARCHAR(150) = NULL,
    @customer_type  VARCHAR(20)  = 'unknown',
    @is_verified    BIT          = 0,
    @verify_method  VARCHAR(20)  = NULL
)
AS
BEGIN
    SET NOCOUNT ON;
    BEGIN TRANSACTION;

    IF NOT EXISTS (
        SELECT 1
        FROM  ai_call_system_caller_registry WITH (UPDLOCK, HOLDLOCK)
        WHERE PhoneNumber = @phone
    )
    BEGIN
        INSERT INTO ai_call_system_caller_registry
            (PhoneNumber, AgentID, CallerName, CallerEmail, CustomerType, IsVerified, VerifyMethod)
        VALUES
            (@phone, @agent_id, @caller_name, @caller_email, @customer_type, @is_verified, @verify_method);
        SELECT SCOPE_IDENTITY() AS RegistryID;
    END
    ELSE
    BEGIN
        SELECT RegistryID FROM ai_call_system_caller_registry WHERE PhoneNumber = @phone;
    END

    COMMIT TRANSACTION;
END
GO
PRINT 'SP created: sp_InsertCallerRegistry_Ai_call_system';
GO

-- ============================================================
-- SP 8: sp_UpdateCallerRegistry_Ai_call_system
-- Partial update + bumps LastSeenAt and TotalCalls on every call.
-- ============================================================
IF OBJECT_ID('sp_UpdateCallerRegistry_Ai_call_system', 'P') IS NOT NULL
    DROP PROCEDURE sp_UpdateCallerRegistry_Ai_call_system;
GO
CREATE PROCEDURE sp_UpdateCallerRegistry_Ai_call_system
(
    @phone          VARCHAR(20),
    @agent_id       VARCHAR(50)  = NULL,
    @caller_name    VARCHAR(100) = NULL,
    @caller_email   VARCHAR(150) = NULL,
    @customer_type  VARCHAR(20)  = NULL,
    @is_verified    BIT          = NULL,
    @verify_method  VARCHAR(20)  = NULL,
    @verified_at    DATETIME     = NULL,
    @notes          VARCHAR(500) = NULL
)
AS
BEGIN
    SET NOCOUNT ON;
    UPDATE ai_call_system_caller_registry SET
        AgentID      = ISNULL(@agent_id,      AgentID),
        CallerName   = ISNULL(@caller_name,   CallerName),
        CallerEmail  = ISNULL(@caller_email,  CallerEmail),
        CustomerType = ISNULL(@customer_type, CustomerType),
        IsVerified   = ISNULL(@is_verified,   IsVerified),
        VerifyMethod = ISNULL(@verify_method, VerifyMethod),
        VerifiedAt   = ISNULL(@verified_at,   VerifiedAt),
        Notes        = ISNULL(@notes,         Notes),
        LastSeenAt   = GETDATE(),
        TotalCalls   = TotalCalls + 1
    WHERE PhoneNumber = @phone;
    SELECT @@ROWCOUNT AS RowsAffected;
END
GO
PRINT 'SP created: sp_UpdateCallerRegistry_Ai_call_system';
GO

-- ============================================================
-- SP 9: sp_InsertCommLog_Ai_call_system
-- Logs an outbound email / SMS / WhatsApp message.
-- ============================================================
IF OBJECT_ID('sp_InsertCommLog_Ai_call_system', 'P') IS NOT NULL
    DROP PROCEDURE sp_InsertCommLog_Ai_call_system;
GO
CREATE PROCEDURE sp_InsertCommLog_Ai_call_system
(
    @call_id         BIGINT        = NULL,
    @channel         VARCHAR(20),
    @recipient_phone VARCHAR(20)   = NULL,
    @recipient_email VARCHAR(200)  = NULL,
    @subject         NVARCHAR(300) = NULL,
    @body            NVARCHAR(MAX) = NULL,
    @twilio_msg_sid  VARCHAR(50)   = NULL,
    @status          VARCHAR(20)   = 'sent'
)
AS
BEGIN
    SET NOCOUNT ON;
    INSERT INTO ai_call_system_comm_logs
        (CallID, Channel, RecipientPhone, RecipientEmail, Subject, Body, TwilioMsgSID, Status)
    VALUES
        (@call_id, @channel, @recipient_phone, @recipient_email, @subject, @body, @twilio_msg_sid, @status);
    SELECT SCOPE_IDENTITY() AS LogID;
END
GO
PRINT 'SP created: sp_InsertCommLog_Ai_call_system';
GO

-- ============================================================
-- SP 10: sp_InsertCallback_Ai_call_system
-- Queues a callback request. Returns new QueueID.
-- ============================================================
IF OBJECT_ID('sp_InsertCallback_Ai_call_system', 'P') IS NOT NULL
    DROP PROCEDURE sp_InsertCallback_Ai_call_system;
GO
CREATE PROCEDURE sp_InsertCallback_Ai_call_system
(
    @phone      VARCHAR(20),
    @call_id    BIGINT        = NULL,
    @reason     NVARCHAR(500) = NULL,
    @department VARCHAR(20)   = 'sales',
    @priority   INT           = 1
)
AS
BEGIN
    SET NOCOUNT ON;
    INSERT INTO ai_call_system_callback_queue
        (Phone, CallID, Reason, Department, Priority, Status)
    VALUES
        (@phone, @call_id, @reason, @department, @priority, 'pending');
    SELECT SCOPE_IDENTITY() AS QueueID;
END
GO
PRINT 'SP created: sp_InsertCallback_Ai_call_system';
GO

-- ============================================================
-- SP 11: sp_GetPendingCallbacks_Ai_call_system
-- Dequeue pending callbacks — high priority first, oldest first.
-- ============================================================
IF OBJECT_ID('sp_GetPendingCallbacks_Ai_call_system', 'P') IS NOT NULL
    DROP PROCEDURE sp_GetPendingCallbacks_Ai_call_system;
GO
CREATE PROCEDURE sp_GetPendingCallbacks_Ai_call_system
AS
BEGIN
    SET NOCOUNT ON;
    SELECT * FROM ai_call_system_callback_queue
    WHERE  Status = 'pending'
    ORDER BY Priority DESC, ScheduledAt ASC;
END
GO
PRINT 'SP created: sp_GetPendingCallbacks_Ai_call_system';
GO

-- ============================================================
-- SP 12: sp_UpdateCallbackStatus_Ai_call_system
-- Mark a callback as called / cancelled.
-- ============================================================
IF OBJECT_ID('sp_UpdateCallbackStatus_Ai_call_system', 'P') IS NOT NULL
    DROP PROCEDURE sp_UpdateCallbackStatus_Ai_call_system;
GO
CREATE PROCEDURE sp_UpdateCallbackStatus_Ai_call_system
(
    @queue_id BIGINT,
    @status   VARCHAR(20),
    @notes    NVARCHAR(300) = NULL
)
AS
BEGIN
    SET NOCOUNT ON;
    UPDATE ai_call_system_callback_queue SET
        Status   = @status,
        CalledAt = CASE WHEN @status = 'called' THEN GETDATE() ELSE CalledAt END,
        Notes    = ISNULL(@notes, Notes)
    WHERE QueueID = @queue_id;
    SELECT @@ROWCOUNT AS RowsAffected;
END
GO
PRINT 'SP created: sp_UpdateCallbackStatus_Ai_call_system';
GO

-- ============================================================
-- Setup complete.
-- ============================================================
PRINT '================================================';
PRINT 'setup.sql finished — 4 tables + 12 SPs ready.';
PRINT '================================================';
GO
