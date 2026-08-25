import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { executionQueueService } from "../services/execution-queue.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

export function executionQueueRoutes(db: Db, deps: { autoStartAfterDispatch?: boolean } = {}) {
  const router = Router();
  const queue = executionQueueService(db, deps);

  router.get("/companies/:companyId/execution-queue", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await queue.summary(companyId));
  });

  router.post("/companies/:companyId/execution-queue/dispatch-next", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    res.json(await queue.dispatchNext(companyId));
  });

  return router;
}
