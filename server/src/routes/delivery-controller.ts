import { Router } from "express";
import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import { badRequest } from "../errors.js";
import {
  deliveryControllerService,
  describeNextAction,
  type DeliveryControllerDeps,
} from "../services/delivery-controller.js";
import { assertBoard, assertInstanceAdmin } from "./authz.js";

// The authenticated Paperclip surface for the delivery controller. Not
// company-scoped — a delivery candidate is Paperclip's own source code, not
// tenant data, so every route here lives at the top level, not under
// /companies/:companyId.
//
// Authorization split, per the owner's explicit instruction:
//   - route contract create/revoke: assertInstanceAdmin — only a board actor
//     with instance-admin access may author or revoke standing publish
//     authority. This is the actual human-decision boundary; nothing here
//     lets an agent or a lesser board actor create its own authority.
//   - everything else (submit / evaluate / publish / query): assertBoard —
//     authenticated board access, matching how execution-queue.ts gated its
//     own mutating dispatch-next endpoint. Not opened to agent actors in
//     this version.
//
// Activity logging: every mutation here is recorded — not via the shared,
// company-scoped activityLog/logActivity system (delivery_candidates and
// delivery_route_contracts have no companyId; activity_log.company_id is a
// hard NOT NULL FK, so forcing this domain through it would mean inventing a
// fake company). Instead, every candidate mutation already durably logs
// through transitionCandidate()'s own delivery_transitions insert (see that
// function's comment), and every contract mutation is durably recorded on
// the contract row itself (authorizedByUserId/createdAt,
// revokedByUserId/revokedAt — a contract has exactly two lifecycle events,
// ever, and neither is overwritten by the other). Both are real and
// queryable. What they do NOT yet do is appear in Paperclip's shared
// per-company "Recent Activity" dashboard feed — flagged here as a known,
// deliberate gap for this version, not a silent omission.
export function deliveryControllerRoutes(db: Db, deps: DeliveryControllerDeps) {
  const router = Router();
  const svc = deliveryControllerService(db, deps);

  function actorLabel(req: Request): string {
    return `board:${req.actor.type === "board" ? (req.actor.userId ?? "board") : "unknown"}`;
  }

  router.post("/delivery-candidates", async (req, res) => {
    assertBoard(req);
    const body = req.body as Record<string, unknown>;
    const candidate = await svc.submitCandidate({
      repo: String(body.repo ?? ""),
      branch: String(body.branch ?? ""),
      baseBranch: String(body.baseBranch ?? ""),
      sha: String(body.sha ?? ""),
      sourceWorktreePath: String(body.sourceWorktreePath ?? ""),
      validationReceipt: (body.validationReceipt as Record<string, unknown>) ?? {},
      submittedByActor: actorLabel(req),
    });
    res.status(201).json(candidate);
  });

  router.get("/delivery-candidates", async (req, res) => {
    assertBoard(req);
    const repo = typeof req.query.repo === "string" ? req.query.repo : undefined;
    const state = typeof req.query.state === "string" ? req.query.state : undefined;
    const candidates = await svc.listCandidates({ repo, state });
    res.json(candidates.map((candidate) => ({ ...candidate, nextAction: describeNextAction(candidate) })));
  });

  router.get("/delivery-candidates/:id", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const candidate = await svc.getCandidate(id);
    const transitions = await svc.listTransitions(id);
    res.json({ ...candidate, nextAction: describeNextAction(candidate), transitions });
  });

  router.post("/delivery-candidates/:id/evaluate", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const candidate = await svc.evaluatePublicationAuthorization(id, actorLabel(req));
    res.json(candidate);
  });

  // Operator diagnostic/retry surface, NOT the normal transition path. The
  // normal path is delivery-controller-worker.ts's runWorkerTick(), which
  // calls claimForPublish()/publish() on a schedule with no human in the
  // loop. This endpoint exists for a human to force an attempt right now —
  // e.g. retrying a publish_failed candidate after reading why it failed —
  // not for routine automation to depend on.
  router.post("/delivery-candidates/:id/publish", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const candidate = await svc.publish(id, actorLabel(req));
    res.json(candidate);
  });

  router.post("/delivery-route-contracts", async (req, res) => {
    assertInstanceAdmin(req);
    const body = req.body as Record<string, unknown>;
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw badRequest("An identified board actor is required to author a route contract");
    }
    const contract = await svc.createRouteContract({
      repo: String(body.repo ?? ""),
      branchPattern: String(body.branchPattern ?? ""),
      baseBranch: String(body.baseBranch ?? ""),
      action: String(body.action ?? "publish"),
      constraints: (body.constraints as Record<string, unknown>) ?? {},
      authorizedByUserId: req.actor.userId,
      autoRetryLimit: typeof body.autoRetryLimit === "number" ? body.autoRetryLimit : undefined,
      retryBackoffSeconds: typeof body.retryBackoffSeconds === "number" ? body.retryBackoffSeconds : undefined,
    });
    res.status(201).json(contract);
  });

  router.post("/delivery-route-contracts/:id/revoke", async (req, res) => {
    assertInstanceAdmin(req);
    const id = req.params.id as string;
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw badRequest("An identified board actor is required to revoke a route contract");
    }
    const contract = await svc.revokeRouteContract(id, req.actor.userId);
    res.json(contract);
  });

  // The runtime half of the worker's two-layer activation gate (see
  // delivery_worker_activation.ts) — instance-admin-only, same authority
  // tier as route contracts, since this is what actually lets an already-
  // deployed scheduler start touching git/GitHub unattended.
  router.post("/delivery-worker-activation", async (req, res) => {
    assertInstanceAdmin(req);
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw badRequest("An identified board actor is required to activate the delivery worker");
    }
    const body = req.body as Record<string, unknown>;
    const reason = typeof body.reason === "string" ? body.reason : undefined;
    const activation = await svc.activateWorker(req.actor.userId, reason);
    res.status(201).json(activation);
  });

  router.post("/delivery-worker-activation/deactivate", async (req, res) => {
    assertInstanceAdmin(req);
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw badRequest("An identified board actor is required to deactivate the delivery worker");
    }
    const revoked = await svc.deactivateWorker(req.actor.userId);
    res.json({ revoked });
  });

  router.get("/delivery-worker-activation", async (req, res) => {
    assertBoard(req);
    const status = await svc.getWorkerActivationStatus();
    res.json(status);
  });

  return router;
}
