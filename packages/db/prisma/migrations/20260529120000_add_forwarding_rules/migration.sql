-- Forwarding rules: configurable "Forward to <team>" quick actions on a
-- Contact. Each rule defines the recipients (to/cc/bcc), a subject template,
-- and a body template. The agent triggers it from the contact page, can edit
-- the rendered message inline, and the send is recorded as an
-- `email_forwarded` Interaction on the contact. Default rules seeded below
-- mirror the operational forwarding addresses (ap@, recruitment@, schools@,
-- camps@, partnerships@, plus CEOs). All seeded rules are editable from
-- Settings → Forwarding. CLAUDE.md §27, §45.
--
-- Forward-only (§19). New `email_forwarded` enum value is additive.

-- 1. New Interaction enum value (timeline records "this was forwarded").
ALTER TYPE "InteractionType" ADD VALUE IF NOT EXISTS 'email_forwarded';

-- 2. ForwardingRule table.
CREATE TABLE "ForwardingRule" (
    "id"              TEXT NOT NULL,
    "key"             TEXT NOT NULL,
    "label"           TEXT NOT NULL,
    "description"     TEXT,
    "toAddresses"     TEXT[] NOT NULL,
    "ccAddresses"     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "bccAddresses"    TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "subjectTemplate" TEXT NOT NULL,
    "bodyTemplate"    TEXT NOT NULL,
    "sortOrder"       INTEGER NOT NULL DEFAULT 0,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,
    "createdById"     TEXT,
    "updatedById"     TEXT,
    "archivedAt"      TIMESTAMP(3),
    CONSTRAINT "ForwardingRule_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ForwardingRule_key_key" ON "ForwardingRule"("key");
CREATE INDEX "ForwardingRule_archivedAt_idx" ON "ForwardingRule"("archivedAt");
CREATE INDEX "ForwardingRule_sortOrder_idx" ON "ForwardingRule"("sortOrder");

-- 3. Seed the operational rules. Keys are stable, addresses + templates are
-- editable from Settings → Forwarding. Subject/body use {{contactName}},
-- {{contactEmail}}, {{contactPhone}}, {{agentName}}, {{notes}}, {{contactLink}}
-- — rendered by packages/core/src/forwarding/templates.ts.
INSERT INTO "ForwardingRule" (
    "id", "key", "label", "description",
    "toAddresses", "ccAddresses",
    "subjectTemplate", "bodyTemplate",
    "sortOrder", "updatedAt"
) VALUES
(
    'fwdrule_ap_team',
    'ap_team',
    'Forward to AP Team',
    'Send a query about a contact to the AP team.',
    ARRAY['ap@studymind.co.uk']::TEXT[],
    ARRAY[]::TEXT[],
    'Forwarded query: {{contactName}}',
    E'Hi AP team,\n\n{{notes}}\n\nContact details:\n- Name: {{contactName}}\n- Email: {{contactEmail}}\n- Phone: {{contactPhone}}\n- CRM link: {{contactLink}}\n\nThanks,\n{{agentName}}',
    10,
    CURRENT_TIMESTAMP
),
(
    'fwdrule_ap_recruitment',
    'ap_recruitment',
    'Forward to AP Recruitment',
    'Send tutor recruitment-related queries; cc''d to Sid and Lewis.',
    ARRAY['recruitment@studymind.co.uk']::TEXT[],
    ARRAY['sid@studymind.co.uk', 'lewis@studymind.co.uk']::TEXT[],
    'Recruitment query: {{contactName}}',
    E'Hi recruitment team,\n\n{{notes}}\n\nContact details:\n- Name: {{contactName}}\n- Email: {{contactEmail}}\n- Phone: {{contactPhone}}\n- CRM link: {{contactLink}}\n\nThanks,\n{{agentName}}',
    20,
    CURRENT_TIMESTAMP
),
(
    'fwdrule_ceos',
    'ceos',
    'Forward to CEOs',
    'Escalate to the leadership team.',
    ARRAY['mohil@studymind.co.uk', 'kunal@studymind.co.uk', 'business@studymind.co.uk']::TEXT[],
    ARRAY[]::TEXT[],
    'Escalation: {{contactName}}',
    E'Hi team,\n\n{{notes}}\n\nContact details:\n- Name: {{contactName}}\n- Email: {{contactEmail}}\n- Phone: {{contactPhone}}\n- CRM link: {{contactLink}}\n\nThanks,\n{{agentName}}',
    30,
    CURRENT_TIMESTAMP
),
(
    'fwdrule_schools',
    'schools',
    'Forward to Schools',
    'Schools partnerships queries.',
    ARRAY['schools@studymind.co.uk']::TEXT[],
    ARRAY[]::TEXT[],
    'Schools query: {{contactName}}',
    E'Hi schools team,\n\n{{notes}}\n\nContact details:\n- Name: {{contactName}}\n- Email: {{contactEmail}}\n- Phone: {{contactPhone}}\n- CRM link: {{contactLink}}\n\nThanks,\n{{agentName}}',
    40,
    CURRENT_TIMESTAMP
),
(
    'fwdrule_camps',
    'camps',
    'Forward to Camps',
    'Camps-related queries.',
    ARRAY['camps@studymind.co.uk']::TEXT[],
    ARRAY[]::TEXT[],
    'Camps query: {{contactName}}',
    E'Hi camps team,\n\n{{notes}}\n\nContact details:\n- Name: {{contactName}}\n- Email: {{contactEmail}}\n- Phone: {{contactPhone}}\n- CRM link: {{contactLink}}\n\nThanks,\n{{agentName}}',
    50,
    CURRENT_TIMESTAMP
),
(
    'fwdrule_partnerships',
    'partnerships',
    'Forward to Partnerships',
    'Partnerships and B2B opportunities.',
    ARRAY['partnerships@studymind.co.uk']::TEXT[],
    ARRAY[]::TEXT[],
    'Partnerships query: {{contactName}}',
    E'Hi partnerships team,\n\n{{notes}}\n\nContact details:\n- Name: {{contactName}}\n- Email: {{contactEmail}}\n- Phone: {{contactPhone}}\n- CRM link: {{contactLink}}\n\nThanks,\n{{agentName}}',
    60,
    CURRENT_TIMESTAMP
)
ON CONFLICT ("key") DO NOTHING;
