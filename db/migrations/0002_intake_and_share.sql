-- 0002: intake client scope and rate (ING-02, ING-33), public email domains (ING-23).

ALTER TABLE ing_client
  ADD COLUMN target text NULL CHECK (target ~ '^[a-z_]+:[A-Za-z0-9_-]+$'),
  ADD COLUMN rate_per_minute int NOT NULL DEFAULT 60 CHECK (rate_per_minute BETWEEN 1 AND 600);

INSERT INTO core_setting (key, value) VALUES
  ('intake.public_email_domains', '["gmail.com","googlemail.com","outlook.com","hotmail.com","live.com","yahoo.com","icloud.com","me.com","aol.com","proton.me","protonmail.com","gmx.com","eircom.net"]'),
  ('intake.internal_company_id', 'null'),
  ('export.include_personal_data', 'false')
ON CONFLICT (key) DO NOTHING;
