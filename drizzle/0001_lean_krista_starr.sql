CREATE TABLE "oauth_clients" (
	"client_id" text PRIMARY KEY NOT NULL,
	"client_secret_hash" text,
	"client_name" text,
	"redirect_uris" jsonb NOT NULL,
	"grant_types" jsonb NOT NULL,
	"token_endpoint_auth_method" text DEFAULT 'client_secret_post' NOT NULL,
	"scope" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"code_challenge_method" text DEFAULT 'S256' NOT NULL,
	"scope" text NOT NULL,
	"resource" text,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"client_id" text NOT NULL,
	"scope" text NOT NULL,
	"resource" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "oauth_clients_created_at_idx" ON "oauth_clients" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "oauth_codes_expires_at_idx" ON "oauth_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "oauth_tokens_client_id_idx" ON "oauth_tokens" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_tokens_expires_at_idx" ON "oauth_tokens" USING btree ("expires_at");