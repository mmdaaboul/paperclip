CREATE TABLE "agent_reference_folder_configs" (
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"entries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_by_user_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_reference_folder_configs_company_id_agent_id_pk" PRIMARY KEY("company_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "agent_reviewer_policies" (
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_by_user_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_reviewer_policies_company_id_agent_id_pk" PRIMARY KEY("company_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "github_push_operation_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"binding" jsonb NOT NULL,
	"request" jsonb NOT NULL,
	"fingerprint" text NOT NULL,
	"state" text NOT NULL,
	"reason" text,
	"confirmation_source" text,
	"created_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "github_push_operation_receipts_run_key_unique" UNIQUE("company_id","agent_id","run_id","idempotency_key"),
	CONSTRAINT "github_push_operation_receipts_fingerprint_valid" CHECK ("github_push_operation_receipts"."fingerprint" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "github_push_operation_receipts_state_valid" CHECK ("github_push_operation_receipts"."state" in ('pending','confirmed','no_change','failed','uncertain')),
	CONSTRAINT "github_push_operation_receipts_source_valid" CHECK ("github_push_operation_receipts"."confirmation_source" is null or "github_push_operation_receipts"."confirmation_source"='git_receive_pack_status'),
	CONSTRAINT "github_push_operation_receipts_actor_binding" CHECK (coalesce(jsonb_typeof("github_push_operation_receipts"."binding")='object' and "github_push_operation_receipts"."binding"->>'companyId'="github_push_operation_receipts"."company_id"::text
    and "github_push_operation_receipts"."binding"->>'agentId'="github_push_operation_receipts"."agent_id"::text and "github_push_operation_receipts"."binding"->>'runId'="github_push_operation_receipts"."run_id"::text, false)),
	CONSTRAINT "github_push_operation_receipts_request_binding" CHECK (coalesce(jsonb_typeof("github_push_operation_receipts"."request")='object' and "github_push_operation_receipts"."request"->>'idempotencyKey'="github_push_operation_receipts"."idempotency_key"::text, false)),
	CONSTRAINT "github_push_operation_receipts_confirmation" CHECK (("github_push_operation_receipts"."state"='confirmed')=("github_push_operation_receipts"."confirmation_source" is not null)),
	CONSTRAINT "github_push_operation_receipts_finished" CHECK (("github_push_operation_receipts"."state"='pending')=("github_push_operation_receipts"."finished_at" is null))
);
--> statement-breakpoint
CREATE TABLE "issue_review_cycle_budgets" (
	"issue_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"ledger" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_review_cycle_budgets_revision_positive" CHECK ("issue_review_cycle_budgets"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "issue_scoped_reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"snapshot" jsonb NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"interaction_id" uuid,
	"source_decision_id" uuid,
	"verdict" text,
	"verdict_run_id" uuid,
	"return_wakeup_id" uuid,
	"return_status_version" bigint,
	"cancellation" jsonb,
	"version" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviewer_github_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"operation_id" uuid NOT NULL,
	"event" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviewer_github_operations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"repository_id" text NOT NULL,
	"repository" text NOT NULL,
	"pull_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"action" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"agent_name" text NOT NULL,
	"status" text NOT NULL,
	"request_payload" jsonb NOT NULL,
	"receipt" jsonb,
	"error_code" text,
	"claim_token" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"write_started_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	CONSTRAINT "reviewer_github_operations_run_key_unique" UNIQUE("company_id","agent_id","run_id","idempotency_key"),
	CONSTRAINT "reviewer_github_operations_pull_positive" CHECK ("reviewer_github_operations"."pull_number" > 0),
	CONSTRAINT "reviewer_github_operations_action_valid" CHECK ("reviewer_github_operations"."action" in ('comment','reply','resolve_own_finding')),
	CONSTRAINT "reviewer_github_operations_status_valid" CHECK ("reviewer_github_operations"."status" in ('pending','writing','confirmed','uncertain','rejected')),
	CONSTRAINT "reviewer_github_operations_key_bound" CHECK (char_length("reviewer_github_operations"."idempotency_key") between 1 and 200),
	CONSTRAINT "reviewer_github_operations_write_claim" CHECK ("reviewer_github_operations"."status" <> 'writing' or ("reviewer_github_operations"."claim_token" is not null and "reviewer_github_operations"."write_started_at" is not null)),
	CONSTRAINT "reviewer_github_operations_confirmed_binding" CHECK ("reviewer_github_operations"."status" <> 'confirmed' or coalesce(
    "reviewer_github_operations"."receipt" is not null and jsonb_typeof("reviewer_github_operations"."receipt")='object' and "reviewer_github_operations"."confirmed_at" is not null
    and "reviewer_github_operations"."receipt"->>'operationId'="reviewer_github_operations"."id"::text and "reviewer_github_operations"."receipt"->>'action'="reviewer_github_operations"."action"
    and "reviewer_github_operations"."receipt"->>'companyId'="reviewer_github_operations"."company_id"::text and "reviewer_github_operations"."receipt"->>'agentId'="reviewer_github_operations"."agent_id"::text
    and "reviewer_github_operations"."receipt"->>'runId'="reviewer_github_operations"."run_id"::text and "reviewer_github_operations"."receipt"->>'issueId'="reviewer_github_operations"."issue_id"::text
    and "reviewer_github_operations"."receipt"->>'projectId'="reviewer_github_operations"."project_id"::text and "reviewer_github_operations"."receipt"->>'repositoryId'="reviewer_github_operations"."repository_id"
    and "reviewer_github_operations"."receipt"->>'repository'="reviewer_github_operations"."repository" and "reviewer_github_operations"."receipt"->>'pullNumber'="reviewer_github_operations"."pull_number"::text
    and "reviewer_github_operations"."receipt"->>'headSha'="reviewer_github_operations"."head_sha" and "reviewer_github_operations"."receipt"->>'agentNameAtTime'="reviewer_github_operations"."agent_name"
    and (case when "reviewer_github_operations"."action"='resolve_own_finding' then "reviewer_github_operations"."receipt"->>'threadId' is not null
      else "reviewer_github_operations"."receipt"->>'commentId' ~ '^[1-9][0-9]*$' end), false))
);
--> statement-breakpoint
ALTER TABLE "agent_reference_folder_configs" ADD CONSTRAINT "agent_reference_folder_configs_company_id_agent_id_agents_company_id_id_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_reviewer_policies" ADD CONSTRAINT "agent_reviewer_policies_company_id_agent_id_agents_company_id_id_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_review_cycle_budgets" ADD CONSTRAINT "issue_review_cycle_budgets_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_review_cycle_budgets" ADD CONSTRAINT "issue_review_cycle_budgets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_scoped_reviews" ADD CONSTRAINT "issue_scoped_reviews_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_scoped_reviews" ADD CONSTRAINT "issue_scoped_reviews_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_scoped_reviews" ADD CONSTRAINT "issue_scoped_reviews_interaction_id_issue_thread_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."issue_thread_interactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_scoped_reviews" ADD CONSTRAINT "issue_scoped_reviews_source_decision_id_status_decisions_id_fk" FOREIGN KEY ("source_decision_id") REFERENCES "public"."status_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_scoped_reviews" ADD CONSTRAINT "issue_scoped_reviews_verdict_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("verdict_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_scoped_reviews" ADD CONSTRAINT "issue_scoped_reviews_return_wakeup_id_agent_wakeup_requests_id_fk" FOREIGN KEY ("return_wakeup_id") REFERENCES "public"."agent_wakeup_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewer_github_events" ADD CONSTRAINT "reviewer_github_events_operation_id_reviewer_github_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."reviewer_github_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_scoped_reviews_one_active_task_uq" ON "issue_scoped_reviews" USING btree ("company_id","issue_id") WHERE "issue_scoped_reviews"."state" in ('draft', 'pending', 'cancelling');--> statement-breakpoint
CREATE INDEX "reviewer_github_own_findings_idx" ON "reviewer_github_operations" USING btree ("company_id","agent_id","issue_id","project_id","repository_id","pull_number","created_at","id") WHERE "reviewer_github_operations"."status"='confirmed' and "reviewer_github_operations"."action"='comment' and "reviewer_github_operations"."receipt"->>'findingKey' is not null;