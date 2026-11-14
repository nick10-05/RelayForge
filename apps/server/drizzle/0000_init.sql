CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"secret_hash" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"destination_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"dead_reason" text,
	"trigger" text DEFAULT 'auto' NOT NULL,
	"replay_of" uuid,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"last_status_code" integer,
	"last_error" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deliveries_status_chk" CHECK ("deliveries"."status" IN ('pending', 'in_flight', 'succeeded', 'dead')),
	CONSTRAINT "deliveries_dead_reason_chk" CHECK (("deliveries"."status" = 'dead') = ("deliveries"."dead_reason" IS NOT NULL) AND ("deliveries"."dead_reason" IS NULL OR "deliveries"."dead_reason" IN ('exhausted', 'non_retryable_status', 'redirect', 'ssrf_blocked', 'destination_disabled'))),
	CONSTRAINT "deliveries_trigger_chk" CHECK ("deliveries"."trigger" IN ('auto', 'manual')),
	CONSTRAINT "deliveries_attempts_chk" CHECK ("deliveries"."attempt_count" >= 0 AND "deliveries"."max_attempts" BETWEEN 1 AND 15)
);
--> statement-breakpoint
CREATE TABLE "delivery_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"delivery_id" uuid NOT NULL,
	"attempt_no" integer NOT NULL,
	"worker_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"duration_ms" integer,
	"status_code" integer,
	"response_headers" jsonb,
	"response_body_snippet" text,
	"error_code" text,
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE "destinations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"url" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"timeout_ms" integer DEFAULT 10000 NOT NULL,
	"max_attempts" integer DEFAULT 10 NOT NULL,
	"signing_secret_enc" text,
	"prev_signing_secret_enc" text,
	"prev_secret_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "destinations_timeout_chk" CHECK ("destinations"."timeout_ms" BETWEEN 1000 AND 15000),
	CONSTRAINT "destinations_max_attempts_chk" CHECK ("destinations"."max_attempts" BETWEEN 1 AND 15)
);
--> statement-breakpoint
CREATE TABLE "endpoints" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"verify_scheme" text DEFAULT 'none' NOT NULL,
	"verify_header" text,
	"verify_prefix" text,
	"verify_encoding" text,
	"verify_secret_enc" text,
	"dedupe_source" text DEFAULT 'none' NOT NULL,
	"dedupe_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "endpoints_verify_scheme_chk" CHECK ("endpoints"."verify_scheme" IN ('none', 'hmac', 'standard_webhooks')),
	CONSTRAINT "endpoints_verify_encoding_chk" CHECK ("endpoints"."verify_encoding" IS NULL OR "endpoints"."verify_encoding" IN ('hex', 'base64')),
	CONSTRAINT "endpoints_dedupe_source_chk" CHECK ("endpoints"."dedupe_source" IN ('none', 'header', 'json_field')),
	CONSTRAINT "endpoints_dedupe_name_chk" CHECK (("endpoints"."dedupe_source" = 'none') = ("endpoints"."dedupe_name" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"query" text,
	"headers" jsonb NOT NULL,
	"body" "bytea" NOT NULL,
	"body_truncated" boolean DEFAULT false NOT NULL,
	"content_type" text,
	"size_bytes" integer NOT NULL,
	"source_ip" text,
	"dedupe_key" text,
	"duplicate_count" integer DEFAULT 0 NOT NULL,
	"last_duplicate_at" timestamp with time zone,
	"signature_status" text DEFAULT 'not_checked' NOT NULL,
	"signature_failure_reason" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_signature_status_chk" CHECK ("events"."signature_status" IN ('not_checked', 'valid', 'invalid'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_lowercase" CHECK ("users"."email" = lower("users"."email"))
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_destination_id_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."destinations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_replay_of_deliveries_id_fk" FOREIGN KEY ("replay_of") REFERENCES "public"."deliveries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "destinations" ADD CONSTRAINT "destinations_endpoint_id_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoints" ADD CONSTRAINT "endpoints_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_endpoint_id_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_prefix_uq" ON "api_keys" USING btree ("prefix");--> statement-breakpoint
CREATE INDEX "api_keys_user_idx" ON "api_keys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "deliveries_due_idx" ON "deliveries" USING btree ("next_attempt_at") WHERE "deliveries"."status" IN ('pending', 'in_flight');--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_one_active_uq" ON "deliveries" USING btree ("event_id","destination_id") WHERE "deliveries"."status" IN ('pending', 'in_flight');--> statement-breakpoint
CREATE INDEX "deliveries_event_idx" ON "deliveries" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "deliveries_destination_idx" ON "deliveries" USING btree ("destination_id");--> statement-breakpoint
CREATE INDEX "delivery_attempts_delivery_idx" ON "delivery_attempts" USING btree ("delivery_id","attempt_no");--> statement-breakpoint
CREATE INDEX "destinations_endpoint_idx" ON "destinations" USING btree ("endpoint_id");--> statement-breakpoint
CREATE UNIQUE INDEX "endpoints_slug_uq" ON "endpoints" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "endpoints_user_idx" ON "endpoints" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "events_endpoint_dedupe_key_uq" ON "events" USING btree ("endpoint_id","dedupe_key") WHERE "events"."dedupe_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "events_endpoint_received_idx" ON "events" USING btree ("endpoint_id","received_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "events_invalid_received_idx" ON "events" USING btree ("received_at") WHERE "events"."signature_status" = 'invalid';--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_uq" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree ("email");