import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext, PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { ACTION_KEYS, DATA_KEYS, STREAM_CHANNELS } from "./constants.js";
import {
  createThread,
  decideProposal,
  getThreadWithMessages,
  listThreads,
  proposeAction,
  sendMessage,
} from "./companion-service.js";
import type { CompanionHost } from "./types.js";

function requireCompanyId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("companyId is required");
  }
  return value;
}

function requireString(value: unknown, field: string, maxLength = 20_000): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) throw new Error(`${field} must be at most ${maxLength} characters`);
  return trimmed;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireUuid(value: unknown, field: string): string {
  const text = requireString(value, field, 36);
  if (!UUID_PATTERN.test(text)) throw new Error(`${field} must be a UUID`);
  return text;
}

/** Maps the real ctx.* clients onto the narrow CompanionHost interface companion-service.ts consumes. */
function toHost(ctx: PluginContext): CompanionHost {
  return {
    db: ctx.db,
    issues: {
      list: ctx.issues.list,
      create: ctx.issues.create,
      requestConfirmation: (issueId, interaction, companyId) =>
        ctx.issues.requestConfirmation(issueId, interaction, companyId),
      respondInteraction: (issueId, interactionId, input, companyId) =>
        ctx.issues.respondInteraction(issueId, interactionId, input, companyId),
    },
    agents: { list: ctx.agents.list },
    activity: { log: ctx.activity.log },
    secrets: { resolve: ctx.secrets.resolve },
    http: { fetch: ctx.http.fetch },
    localFolders: {
      status: ctx.localFolders.status,
      readText: ctx.localFolders.readText,
      list: async (companyId, folderKey) => {
        const listing = await ctx.localFolders.list(companyId, folderKey);
        return listing.entries.map((e) => ({ path: e.path, isDirectory: e.kind === "directory" }));
      },
    },
    config: { get: ctx.config.get },
    now: () => new Date(),
  };
}

/** Only a real host-authenticated human actor may be attributed as the acting user; never trust client-supplied ids. */
function humanActorUserId(context: PluginPerformActionContext): string | undefined {
  return context.actor.type === "user" && context.actor.userId ? context.actor.userId : undefined;
}

export const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    const host = toHost(ctx);

    ctx.data.register(DATA_KEYS.threads, async (params) => {
      const companyId = requireCompanyId(params.companyId);
      return listThreads(host, companyId);
    });

    ctx.data.register(DATA_KEYS.thread, async (params) => {
      const companyId = requireCompanyId(params.companyId);
      // The UI hook is unconditional to preserve React hook ordering. Before
      // the thread list resolves there is intentionally no selected id; return
      // an empty result instead of turning that normal loading phase into a
      // noisy 502.
      if (params.threadId === undefined || params.threadId === null || params.threadId === "") return null;
      const threadId = requireUuid(params.threadId, "threadId");
      return getThreadWithMessages(host, companyId, threadId);
    });

    ctx.actions.register(ACTION_KEYS.createThread, async (params, context) => {
      const companyId = requireCompanyId(context.companyId ?? params.companyId);
      const actorUserId = humanActorUserId(context);
      if (!actorUserId) throw new Error("createThread requires an authenticated human actor");
      const title = typeof params.title === "string" ? requireString(params.title, "title", 200) : "New conversation";
      return createThread(host, companyId, actorUserId, title);
    });

    ctx.actions.register(ACTION_KEYS.sendMessage, async (params, context) => {
      const companyId = requireCompanyId(context.companyId ?? params.companyId);
      const actorUserId = humanActorUserId(context);
      if (!actorUserId) throw new Error("sendMessage requires an authenticated human actor");
      const threadId = requireUuid(params.threadId, "threadId");
      const body = requireString(params.body, "body");
      const clientRequestId = params.clientRequestId === undefined || params.clientRequestId === null
        ? null
        : requireUuid(params.clientRequestId, "clientRequestId");
      const result = await sendMessage(host, companyId, threadId, actorUserId, body, clientRequestId);
      // Known MVP limitation (see design record §6): this is a single buffered
      // emit, not token-level streaming — the full reply is already computed
      // by the time this fires. Kept so the streaming plumbing (ctx.streams +
      // usePluginStream) is genuinely wired end-to-end for a future
      // incremental version, rather than only documented as a plan.
      ctx.streams.open(STREAM_CHANNELS.companionReply, companyId);
      ctx.streams.emit(STREAM_CHANNELS.companionReply, { threadId, message: result.companionMessage });
      ctx.streams.close(STREAM_CHANNELS.companionReply);
      return result;
    });

    ctx.actions.register(ACTION_KEYS.proposeAction, async (params, context) => {
      const companyId = requireCompanyId(context.companyId ?? params.companyId);
      const actorUserId = humanActorUserId(context);
      if (!actorUserId) throw new Error("proposeAction requires an authenticated human actor");
      const threadId = requireUuid(params.threadId, "threadId");
      const messageId = requireUuid(params.messageId, "messageId");
      const summary = requireString(params.summary, "summary", 2_000);
      const detailsMarkdown = typeof params.detailsMarkdown === "string" ? params.detailsMarkdown : undefined;
      return proposeAction(host, companyId, threadId, messageId, summary, detailsMarkdown);
    });

    ctx.actions.register(ACTION_KEYS.decideProposal, async (params, context) => {
      const companyId = requireCompanyId(context.companyId ?? params.companyId);
      const proposalId = requireUuid(params.proposalId, "proposalId");
      const action = params.action === "accept" || params.action === "reject" ? params.action : null;
      if (!action) throw new Error('action must be "accept" or "reject"');
      // Deliberately do NOT fall back to any plugin-supplied identity here.
      // humanActorUserId() returns undefined for anything other than a real
      // host-verified user actor, and decideProposal() rejects that outright.
      const actorUserId = humanActorUserId(context);
      return decideProposal(host, companyId, proposalId, action, actorUserId);
    });
  },
});

runWorker(plugin, import.meta.url);
