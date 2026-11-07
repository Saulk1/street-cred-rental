CREATE TABLE "energy_reports" (
	"id" integer PRIMARY KEY NOT NULL,
	"year" integer NOT NULL,
	"fy" text NOT NULL,
	"report_date" date,
	"report_category" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"co2" numeric,
	"co2_scope1" numeric,
	"co2_scope2" numeric,
	"mwh" numeric,
	"gj" numeric,
	CONSTRAINT "energy_reports_id_positive" CHECK ("energy_reports"."id" > 0),
	CONSTRAINT "energy_reports_year_valid" CHECK ("energy_reports"."year" between 1 and 9999),
	CONSTRAINT "energy_reports_fy_format" CHECK ("energy_reports"."fy" ~ '^[0-9]{4}-[0-9]{2}$'),
	CONSTRAINT "energy_reports_category_not_blank" CHECK (length(trim("energy_reports"."report_category")) > 0),
	CONSTRAINT "energy_reports_code_not_blank" CHECK (length(trim("energy_reports"."code")) > 0),
	CONSTRAINT "energy_reports_name_not_blank" CHECK (length(trim("energy_reports"."name")) > 0)
);
--> statement-breakpoint
CREATE INDEX "energy_reports_code_category_year_idx" ON "energy_reports" USING btree ("code","report_category","year");