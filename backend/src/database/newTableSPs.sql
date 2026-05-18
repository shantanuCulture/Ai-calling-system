-- ============================================================
-- New SPs for AI Call System tables
-- Run this script once on DevDatabase_Staging
-- ============================================================

-- ── sp_InsertCallLog_Ai_call_system ──────────────────────────
IF OBJECT_ID('sp_InsertCallLog_Ai_call_system', 'P') IS NOT NULL
    DROP PROCEDURE sp_InsertCallLog_Ai_call_system;
GO
CREATE PROCEDURE sp_InsertCallLog_Ai_call_system
(
    @twilio_call_sid  VARCHAR(50),
    @caller_phone     VARCHAR(20),
    @called_phone     VARCHAR(20),
    @direction        VARCHAR(10),
    @status           VARCHAR(20),
    @agent_id         VARCHAR(50)  = NULL,
    @intent           VARCHAR(50)  = NULL
)
AS
BEGIN
    SET NOCOUNT ON;

    INSERT INTO call_logs_Ai_call_system
        (twilio_call_sid, caller_phone, called_phone, direction, status, agent_id, intent)
    VALUES
        (@twilio_call_sid, @caller_phone, @called_phone, @direction, @status, @agent_id, @intent);

    SELECT SCOPE_IDENTITY() AS id;
END
GO

-- ── sp_UpdateCallLog_Ai_call_system ──────────────────────────
IF OBJECT_ID('sp_UpdateCallLog_Ai_call_system', 'P') IS NOT NULL
    DROP PROCEDURE sp_UpdateCallLog_Ai_call_system;
GO
CREATE PROCEDURE sp_UpdateCallLog_Ai_call_system
(
    @twilio_call_sid      VARCHAR(50),
    @status               VARCHAR(20)   = NULL,
    @duration_secs        INT           = NULL,
    @recording_sid        VARCHAR(50)   = NULL,
    @recording_url        VARCHAR(500)  = NULL,
    @agent_id             VARCHAR(50)   = NULL,
    @intent               VARCHAR(50)   = NULL,
    @resolved             BIT           = NULL,
    @transferred          BIT           = NULL,
    @callback_scheduled   BIT           = NULL,
    @notes                NVARCHAR(1000)= NULL
)
AS
BEGIN
    SET NOCOUNT ON;

    UPDATE call_logs_Ai_call_system SET
        status              = ISNULL(@status, status),
        duration_secs       = ISNULL(@duration_secs, duration_secs),
        recording_sid       = ISNULL(@recording_sid, recording_sid),
        recording_url       = ISNULL(@recording_url, recording_url),
        agent_id            = ISNULL(@agent_id, agent_id),
        intent              = ISNULL(@intent, intent),
        resolved            = ISNULL(@resolved, resolved),
        transferred         = ISNULL(@transferred, transferred),
        callback_scheduled  = ISNULL(@callback_scheduled, callback_scheduled),
        notes               = ISNULL(@notes, notes),
        updated_at          = GETDATE()
    WHERE twilio_call_sid = @twilio_call_sid;
END
GO

-- ── sp_InsertCommunicationLog_Ai_call_system ─────────────────
IF OBJECT_ID('sp_InsertCommunicationLog_Ai_call_system', 'P') IS NOT NULL
    DROP PROCEDURE sp_InsertCommunicationLog_Ai_call_system;
GO
CREATE PROCEDURE sp_InsertCommunicationLog_Ai_call_system
(
    @channel          VARCHAR(20),
    @recipient_phone  VARCHAR(20)   = NULL,
    @recipient_email  VARCHAR(200)  = NULL,
    @call_log_id      BIGINT        = NULL,
    @subject          NVARCHAR(300) = NULL,
    @body             NVARCHAR(MAX) = NULL,
    @twilio_msg_sid   VARCHAR(50)   = NULL,
    @status           VARCHAR(20)   = 'sent'
)
AS
BEGIN
    SET NOCOUNT ON;

    INSERT INTO communication_logs_Ai_call_system
        (channel, recipient_phone, recipient_email, call_log_id, subject, body, twilio_msg_sid, status)
    VALUES
        (@channel, @recipient_phone, @recipient_email, @call_log_id, @subject, @body, @twilio_msg_sid, @status);

    SELECT SCOPE_IDENTITY() AS id;
END
GO

-- ── sp_InsertCallback_Ai_call_system ─────────────────────────
IF OBJECT_ID('sp_InsertCallback_Ai_call_system', 'P') IS NOT NULL
    DROP PROCEDURE sp_InsertCallback_Ai_call_system;
GO
CREATE PROCEDURE sp_InsertCallback_Ai_call_system
(
    @phone        VARCHAR(20),
    @call_log_id  BIGINT        = NULL,
    @reason       NVARCHAR(500) = NULL,
    @department   VARCHAR(20)   = 'sales',
    @priority     INT           = 1
)
AS
BEGIN
    SET NOCOUNT ON;

    INSERT INTO callback_queue_Ai_call_system
        (phone, call_log_id, reason, department, priority, status)
    VALUES
        (@phone, @call_log_id, @reason, @department, @priority, 'pending');

    SELECT SCOPE_IDENTITY() AS id;
END
GO

-- ── sp_GetPendingCallbacks_Ai_call_system ────────────────────
IF OBJECT_ID('sp_GetPendingCallbacks_Ai_call_system', 'P') IS NOT NULL
    DROP PROCEDURE sp_GetPendingCallbacks_Ai_call_system;
GO
CREATE PROCEDURE sp_GetPendingCallbacks_Ai_call_system
AS
BEGIN
    SET NOCOUNT ON;
    SELECT * FROM callback_queue_Ai_call_system
    WHERE status = 'pending'
    ORDER BY priority ASC, created_at ASC;
END
GO

-- ── sp_UpdateCallbackStatus_Ai_call_system ───────────────────
IF OBJECT_ID('sp_UpdateCallbackStatus_Ai_call_system', 'P') IS NOT NULL
    DROP PROCEDURE sp_UpdateCallbackStatus_Ai_call_system;
GO
CREATE PROCEDURE sp_UpdateCallbackStatus_Ai_call_system
(
    @id       BIGINT,
    @status   VARCHAR(20)
)
AS
BEGIN
    SET NOCOUNT ON;
    UPDATE callback_queue_Ai_call_system
    SET status = @status,
        called_at = CASE WHEN @status = 'called' THEN GETDATE() ELSE called_at END
    WHERE id = @id;
END
GO
