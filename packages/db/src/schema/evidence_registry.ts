import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { assets } from "./assets.js";
import { companies } from "./companies.js";
import { documentRevisions } from "./document_revisions.js";
import { documents } from "./documents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issueWorkProducts } from "./issue_work_products.js";
import { issues } from "./issues.js";

export type EvidenceTargetKind =
  | "source"
  | "artifact"
  | "extraction"
  | "claim"
  | "dataset"
  | "owner"
  | "authority";

export const evidenceOwners = pgTable(
  "evidence_owners",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    ownerType: text("owner_type").notNull().default("unknown"),
    externalId: text("external_id"),
    contactRef: text("contact_ref"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyNameIdx: index("evidence_owners_company_name_idx").on(table.companyId, table.name),
    companyExternalIdUq: uniqueIndex("evidence_owners_company_external_id_uq").on(table.companyId, table.externalId),
  }),
);

export const evidenceAuthorities = pgTable(
  "evidence_authorities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    authorityType: text("authority_type").notNull().default("unknown"),
    jurisdiction: text("jurisdiction"),
    externalId: text("external_id"),
    url: text("url"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyNameIdx: index("evidence_authorities_company_name_idx").on(table.companyId, table.name),
    companyExternalIdUq: uniqueIndex("evidence_authorities_company_external_id_uq").on(
      table.companyId,
      table.externalId,
    ),
  }),
);

export const evidenceSources = pgTable(
  "evidence_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    ownerId: uuid("owner_id").references(() => evidenceOwners.id, { onDelete: "set null" }),
    authorityId: uuid("authority_id").references(() => evidenceAuthorities.id, { onDelete: "set null" }),
    sourceType: text("source_type").notNull(),
    title: text("title").notNull(),
    locator: text("locator").notNull(),
    canonicalUrl: text("canonical_url"),
    retrievedAt: timestamp("retrieved_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyTypeIdx: index("evidence_sources_company_type_idx").on(table.companyId, table.sourceType),
    companyOwnerIdx: index("evidence_sources_company_owner_idx").on(table.companyId, table.ownerId),
    companyAuthorityIdx: index("evidence_sources_company_authority_idx").on(table.companyId, table.authorityId),
    companyLocatorUq: uniqueIndex("evidence_sources_company_locator_uq").on(table.companyId, table.locator),
  }),
);

export const evidenceArtifacts = pgTable(
  "evidence_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id").references(() => evidenceSources.id, { onDelete: "set null" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    assetId: uuid("asset_id").references(() => assets.id, { onDelete: "set null" }),
    documentId: uuid("document_id").references(() => documents.id, { onDelete: "set null" }),
    documentRevisionId: uuid("document_revision_id").references(() => documentRevisions.id, { onDelete: "set null" }),
    workProductId: uuid("work_product_id").references(() => issueWorkProducts.id, { onDelete: "set null" }),
    artifactType: text("artifact_type").notNull(),
    title: text("title").notNull(),
    mimeType: text("mime_type"),
    storageRef: text("storage_ref"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companySourceIdx: index("evidence_artifacts_company_source_idx").on(table.companyId, table.sourceId),
    companyIssueIdx: index("evidence_artifacts_company_issue_idx").on(table.companyId, table.issueId),
    companyAssetIdx: index("evidence_artifacts_company_asset_idx").on(table.companyId, table.assetId),
    companyDocumentIdx: index("evidence_artifacts_company_document_idx").on(table.companyId, table.documentId),
    companyWorkProductIdx: index("evidence_artifacts_company_work_product_idx").on(table.companyId, table.workProductId),
  }),
);

export const evidenceDatasets = pgTable(
  "evidence_datasets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    ownerId: uuid("owner_id").references(() => evidenceOwners.id, { onDelete: "set null" }),
    authorityId: uuid("authority_id").references(() => evidenceAuthorities.id, { onDelete: "set null" }),
    sourceId: uuid("source_id").references(() => evidenceSources.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    version: text("version"),
    license: text("license"),
    locator: text("locator"),
    schemaJson: jsonb("schema_json").$type<Record<string, unknown>>(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyNameIdx: index("evidence_datasets_company_name_idx").on(table.companyId, table.name),
    companySourceIdx: index("evidence_datasets_company_source_idx").on(table.companyId, table.sourceId),
    companyLocatorUq: uniqueIndex("evidence_datasets_company_locator_uq").on(table.companyId, table.locator),
  }),
);

export const evidenceExtractions = pgTable(
  "evidence_extractions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id").references(() => evidenceSources.id, { onDelete: "set null" }),
    artifactId: uuid("artifact_id").references(() => evidenceArtifacts.id, { onDelete: "set null" }),
    datasetId: uuid("dataset_id").references(() => evidenceDatasets.id, { onDelete: "set null" }),
    extractedByAgentId: uuid("extracted_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    extractedByRunId: uuid("extracted_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    method: text("method").notNull(),
    locator: text("locator"),
    rawText: text("raw_text"),
    normalizedJson: jsonb("normalized_json").$type<Record<string, unknown>>(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    extractedAt: timestamp("extracted_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companySourceIdx: index("evidence_extractions_company_source_idx").on(table.companyId, table.sourceId),
    companyArtifactIdx: index("evidence_extractions_company_artifact_idx").on(table.companyId, table.artifactId),
    companyDatasetIdx: index("evidence_extractions_company_dataset_idx").on(table.companyId, table.datasetId),
    companyRunIdx: index("evidence_extractions_company_run_idx").on(table.companyId, table.extractedByRunId),
  }),
);

export const evidenceClaims = pgTable(
  "evidence_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id").references(() => evidenceSources.id, { onDelete: "set null" }),
    artifactId: uuid("artifact_id").references(() => evidenceArtifacts.id, { onDelete: "set null" }),
    extractionId: uuid("extraction_id").references(() => evidenceExtractions.id, { onDelete: "set null" }),
    datasetId: uuid("dataset_id").references(() => evidenceDatasets.id, { onDelete: "set null" }),
    ownerId: uuid("owner_id").references(() => evidenceOwners.id, { onDelete: "set null" }),
    authorityId: uuid("authority_id").references(() => evidenceAuthorities.id, { onDelete: "set null" }),
    claimType: text("claim_type").notNull().default("statement"),
    subject: text("subject"),
    predicate: text("predicate"),
    object: text("object"),
    statement: text("statement").notNull(),
    status: text("status").notNull().default("active"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companySourceIdx: index("evidence_claims_company_source_idx").on(table.companyId, table.sourceId),
    companyArtifactIdx: index("evidence_claims_company_artifact_idx").on(table.companyId, table.artifactId),
    companyExtractionIdx: index("evidence_claims_company_extraction_idx").on(table.companyId, table.extractionId),
    companyDatasetIdx: index("evidence_claims_company_dataset_idx").on(table.companyId, table.datasetId),
    companySubjectIdx: index("evidence_claims_company_subject_idx").on(table.companyId, table.subject),
    companyStatusIdx: index("evidence_claims_company_status_idx").on(table.companyId, table.status),
  }),
);

export const evidenceDateRanges = pgTable(
  "evidence_date_ranges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    targetKind: text("target_kind").$type<EvidenceTargetKind>().notNull(),
    targetId: uuid("target_id").notNull(),
    rangeType: text("range_type").notNull().default("validity"),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    precision: text("precision").notNull().default("instant"),
    timezone: text("timezone"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyTargetIdx: index("evidence_date_ranges_company_target_idx").on(
      table.companyId,
      table.targetKind,
      table.targetId,
    ),
    companyRangeTypeIdx: index("evidence_date_ranges_company_range_type_idx").on(table.companyId, table.rangeType),
  }),
);

export const evidenceHashes = pgTable(
  "evidence_hashes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    targetKind: text("target_kind").$type<EvidenceTargetKind>().notNull(),
    targetId: uuid("target_id").notNull(),
    algorithm: text("algorithm").notNull().default("sha256"),
    value: text("value").notNull(),
    scope: text("scope").notNull().default("content"),
    byteSize: integer("byte_size"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyTargetIdx: index("evidence_hashes_company_target_idx").on(table.companyId, table.targetKind, table.targetId),
    companyAlgorithmValueIdx: index("evidence_hashes_company_algorithm_value_idx").on(
      table.companyId,
      table.algorithm,
      table.value,
    ),
    companyTargetHashUq: uniqueIndex("evidence_hashes_company_target_hash_uq").on(
      table.companyId,
      table.targetKind,
      table.targetId,
      table.algorithm,
      table.value,
      table.scope,
    ),
  }),
);

export const evidenceLineage = pgTable(
  "evidence_lineage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    fromKind: text("from_kind").$type<EvidenceTargetKind>().notNull(),
    fromId: uuid("from_id").notNull(),
    toKind: text("to_kind").$type<EvidenceTargetKind>().notNull(),
    toId: uuid("to_id").notNull(),
    relationType: text("relation_type").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyFromIdx: index("evidence_lineage_company_from_idx").on(table.companyId, table.fromKind, table.fromId),
    companyToIdx: index("evidence_lineage_company_to_idx").on(table.companyId, table.toKind, table.toId),
    companyEdgeUq: uniqueIndex("evidence_lineage_company_edge_uq").on(
      table.companyId,
      table.fromKind,
      table.fromId,
      table.toKind,
      table.toId,
      table.relationType,
    ),
  }),
);

export const evidenceConfidenceScores = pgTable(
  "evidence_confidence_scores",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    targetKind: text("target_kind").$type<EvidenceTargetKind>().notNull(),
    targetId: uuid("target_id").notNull(),
    score: integer("score").notNull(),
    method: text("method").notNull().default("manual"),
    rationale: text("rationale"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyTargetIdx: index("evidence_confidence_scores_company_target_idx").on(
      table.companyId,
      table.targetKind,
      table.targetId,
    ),
    companyMethodIdx: index("evidence_confidence_scores_company_method_idx").on(table.companyId, table.method),
  }),
);

export const evidenceContradictions = pgTable(
  "evidence_contradictions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    subjectClaimId: uuid("subject_claim_id").notNull().references(() => evidenceClaims.id, { onDelete: "cascade" }),
    objectClaimId: uuid("object_claim_id").notNull().references(() => evidenceClaims.id, { onDelete: "cascade" }),
    contradictionType: text("contradiction_type").notNull().default("conflict"),
    severity: text("severity").notNull().default("medium"),
    status: text("status").notNull().default("open"),
    rationale: text("rationale"),
    detectedByAgentId: uuid("detected_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    detectedByRunId: uuid("detected_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companySubjectIdx: index("evidence_contradictions_company_subject_idx").on(table.companyId, table.subjectClaimId),
    companyObjectIdx: index("evidence_contradictions_company_object_idx").on(table.companyId, table.objectClaimId),
    companyStatusIdx: index("evidence_contradictions_company_status_idx").on(table.companyId, table.status),
    companyClaimPairUq: uniqueIndex("evidence_contradictions_company_claim_pair_uq").on(
      table.companyId,
      table.subjectClaimId,
      table.objectClaimId,
      table.contradictionType,
    ),
  }),
);

export const evidenceDispositions = pgTable(
  "evidence_dispositions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    targetKind: text("target_kind").$type<EvidenceTargetKind>().notNull(),
    targetId: uuid("target_id").notNull(),
    disposition: text("disposition").notNull(),
    reason: text("reason"),
    supersedesDispositionId: uuid("supersedes_disposition_id"),
    decidedByAgentId: uuid("decided_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    decidedByRunId: uuid("decided_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    decidedByUserId: text("decided_by_user_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyTargetIdx: index("evidence_dispositions_company_target_idx").on(
      table.companyId,
      table.targetKind,
      table.targetId,
    ),
    companyDispositionIdx: index("evidence_dispositions_company_disposition_idx").on(
      table.companyId,
      table.disposition,
    ),
  }),
);
