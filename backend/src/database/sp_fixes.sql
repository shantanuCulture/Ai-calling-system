-- ============================================================
-- AI Call System — SP Race-Condition & Edge-Case Fixes
-- Safe to run on live data: drops/recreates SPs only,
-- does NOT touch tables or existing rows.
--
-- Run via: node src/database/runSpFixes.js
--
-- Fixes applied:
--   1. sp_InsertCallMaster     — idempotent (Twilio webhook-retry safe)
--   2. sp_InsertCallerRegistry — HOLDLOCK prevents duplicate-insert race
--   3. sp_UpdateCallTopic      — UPDLOCK + transaction prevents lost updates
--   4. sp_UpdateCallMaster     — adds @recording_sid / @recording_url
--   5. sp_CloseCallMaster      — conditional CallEndedAt, NULL-safe @call_status
-- ============================================================

USE DevDatabase_Staging;
GO

-- ============================================================
-- FIX 1: sp_InsertCallMaster_Ai_call_system
--
-- Problem: unique constraint (TwilioCallSID) throws on Twilio
--   webhook retries. dbService swallows the error and returns
--   null. handleOutboundVapi then writes { callId: null } to
--   callSession, overwriting a valid session.
--
-- Fix: return the existing CallID when the SID already exists.
--   The handler treats both paths identically.
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

    -- Idempotent: return existing row if Twilio retried the webhook
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
PRINT 'FIX 1 applied: sp_InsertCallMaster_Ai_call_system (idempotent)';
GO

-- ============================================================
-- FIX 2: sp_InsertCallerRegistry_Ai_call_system
--
-- Problem: two simultaneous calls from the same phone number
--   both pass the IF NOT EXISTS check before either inserts,
--   then both try to INSERT — one fails with unique violation.
--   dbService swallows the error, caller never gets registered.
--
-- Fix: UPDLOCK + HOLDLOCK on the existence check acquires a
--   row lock that prevents a second transaction from even
--   reading past the guard until the first commits.
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
        -- Return existing RegistryID so callers can distinguish insert vs no-op
        SELECT RegistryID FROM ai_call_system_caller_registry WHERE PhoneNumber = @phone;
    END

    COMMIT TRANSACTION;
END
GO
PRINT 'FIX 2 applied: sp_InsertCallerRegistry_Ai_call_system (HOLDLOCK)';
GO

-- ============================================================
-- FIX 3: sp_UpdateCallTopic_Ai_call_system
--
-- Problem: the SP does SELECT TopicsJSON → modify → UPDATE
--   without holding a lock between the read and write.
--   Two concurrent tool calls for the same call both read the
--   same JSON, both compute a new version, and one silently
--   overwrites the other's appended entry.
--
-- Fix: BEGIN TRANSACTION + WITH (UPDLOCK, ROWLOCK) on the
--   SELECT acquires an exclusive update lock for the duration
--   of the transaction, serialising all concurrent topic
--   appends for the same TwilioCallSID.
-- ============================================================
IF OBJECT_ID('sp_UpdateCallTopic_Ai_call_system', 'P') IS NOT NULL
    DROP PROCEDURE sp_UpdateCallTopic_Ai_call_system;
GO
CREATE PROCEDURE sp_UpdateCallTopic_Ai_call_system
(
    @twilio_call_sid VARCHAR(50),
    @topic_name      VARCHAR(50),
    @topic_entry     NVARCHAR(MAX)  -- valid JSON object e.g. {"destination":"Dubai","pax":10}
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

    -- UPDLOCK serialises concurrent writes to TopicsJSON for this call row
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
PRINT 'FIX 3 applied: sp_UpdateCallTopic_Ai_call_system (UPDLOCK + transaction)';
GO

-- ============================================================
-- FIX 4: sp_UpdateCallMaster_Ai_call_system
--
-- Problem: no way to update RecordingSID/RecordingURL via
--   updateCallMaster — the recording webhook was forced to
--   call closeCallMaster, which also sets CallEndedAt and
--   overwrites CallStatus.
--
-- Fix: add @recording_sid and @recording_url params so
--   handleRecordingStatus can update only those fields.
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
PRINT 'FIX 4 applied: sp_UpdateCallMaster_Ai_call_system (recording fields added)';
GO

-- ============================================================
-- FIX 5: sp_CloseCallMaster_Ai_call_system
--
-- Problem A: CallEndedAt = GETDATE() always fires, so the
--   recording webhook (which fires later) overwrites the real
--   end time with a later timestamp.
--
-- Problem B: @call_status defaulted to 'completed', so the
--   recording webhook accidentally overwrote 'failed'/'busy'
--   with 'completed' when it called closeCallMaster.
--
-- Fix A: CallEndedAt is now conditional — only set when NULL.
-- Fix B: @call_status defaults to NULL; ISNULL keeps existing
--   value when caller passes NULL. Callers that want to set
--   'completed' must pass it explicitly.
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
        -- Only stamp end time on the first close; recording webhook re-calls are safe
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
PRINT 'FIX 5 applied: sp_CloseCallMaster_Ai_call_system (conditional CallEndedAt, NULL-safe status)';
GO

PRINT '================================================';
PRINT 'sp_fixes.sql complete — 5 SPs patched.';
PRINT '================================================';
GO
