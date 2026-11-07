CREATE TABLE "rental_events" (
	"session_hash" text NOT NULL,
	"event_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"reply" jsonb NOT NULL,
	CONSTRAINT "rental_events_session_hash_event_id_pk" PRIMARY KEY("session_hash","event_id")
);
--> statement-breakpoint
CREATE TABLE "rental_sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"artifact_version" text,
	"state" jsonb,
	"result" jsonb,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rental_events" ADD CONSTRAINT "rental_events_session_hash_rental_sessions_token_hash_fk" FOREIGN KEY ("session_hash") REFERENCES "public"."rental_sessions"("token_hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rental_sessions_expiry_idx" ON "rental_sessions" USING btree ("expires_at");