CREATE TABLE "board" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "board_is_singleton" CHECK ("board"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "board_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"data" jsonb NOT NULL,
	"source" text DEFAULT 'rest' NOT NULL,
	"replaced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "board_history_replaced_at_idx" ON "board_history" USING btree ("replaced_at");--> statement-breakpoint
CREATE INDEX "board_history_version_idx" ON "board_history" USING btree ("version");