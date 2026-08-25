import React, { useEffect, useState } from "react";
import { usePluginAction, usePluginData, usePluginStream, useHostContext, usePluginToast } from "@paperclipai/plugin-sdk/ui";

interface CompanionThread {
  id: string;
  title: string;
  created_by_user_id: string;
  updated_at: string;
}

interface CompanionEvidenceRef {
  source: string;
  success: boolean;
  summary: string;
  redactedError?: string;
}

interface CompanionMessage {
  id: string;
  role: "human" | "companion";
  actor_user_id: string | null;
  body: string;
  evidence: CompanionEvidenceRef[] | null;
  created_at: string;
}

interface CompanionActionProposal {
  id: string;
  message_id: string;
  summary: string;
  status: "pending" | "accepted" | "rejected";
  decided_by_user_id: string | null;
}

const CONTAINER_STYLE: React.CSSProperties = { display: "flex", height: "100%", minHeight: 480, fontFamily: "inherit" };
const SIDEBAR_STYLE: React.CSSProperties = { width: 240, borderRight: "1px solid var(--border, #e5e5e5)", overflowY: "auto", padding: 8 };
const MAIN_STYLE: React.CSSProperties = { flex: 1, display: "flex", flexDirection: "column", padding: 16, overflow: "hidden" };
const HEADER_STYLE: React.CSSProperties = { marginBottom: 12 };
const MESSAGES_STYLE: React.CSSProperties = { flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 12, paddingBottom: 12 };
const EVIDENCE_STYLE: React.CSSProperties = { fontSize: 12, opacity: 0.75, marginTop: 4, borderLeft: "2px solid currentColor", paddingLeft: 8 };

function CompanionBadge() {
  return (
    <span
      style={{
        display: "inline-block",
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: 0.4,
        textTransform: "uppercase",
        padding: "2px 6px",
        borderRadius: 4,
        background: "var(--accent-muted, #eef)",
      }}
    >
      System assistant — not an organizational agent
    </span>
  );
}

function EvidenceList({ evidence }: { evidence: CompanionEvidenceRef[] | null }) {
  if (!evidence || evidence.length === 0) return null;
  return (
    <div style={EVIDENCE_STYLE}>
      {evidence.map((e, i) => (
        <div key={i}>
          {e.success ? "✓" : "✗"} <strong>{e.source}</strong>: {e.summary}
          {!e.success && e.redactedError ? ` (${e.redactedError})` : ""}
        </div>
      ))}
    </div>
  );
}

function ActionProposalCard({
  proposal,
  onDecide,
}: {
  proposal: CompanionActionProposal;
  onDecide: (id: string, action: "accept" | "reject") => Promise<void>;
}) {
  const [deciding, setDeciding] = useState(false);
  return (
    <div style={{ border: "1px solid var(--border, #ddd)", borderRadius: 6, padding: 10, marginTop: 6 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>Proposed action</div>
      <div style={{ marginBottom: 8 }}>{proposal.summary}</div>
      {proposal.status === "pending" ? (
        <div style={{ display: "flex", gap: 8 }}>
          <button
            disabled={deciding}
            onClick={async () => {
              setDeciding(true);
              try {
                await onDecide(proposal.id, "accept");
              } finally {
                setDeciding(false);
              }
            }}
          >
            Approve
          </button>
          <button
            disabled={deciding}
            onClick={async () => {
              setDeciding(true);
              try {
                await onDecide(proposal.id, "reject");
              } finally {
                setDeciding(false);
              }
            }}
          >
            Reject
          </button>
        </div>
      ) : (
        <div style={{ fontSize: 13, opacity: 0.8 }}>
          {proposal.status === "accepted" ? "Approved" : "Rejected"} by {proposal.decided_by_user_id ?? "unknown"}
        </div>
      )}
    </div>
  );
}

export function CompanionPage() {
  const host = useHostContext();
  const toast = usePluginToast();
  const companyId = host.companyId;

  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [composerValue, setComposerValue] = useState("");
  const [proposals, setProposals] = useState<Record<string, CompanionActionProposal>>({});

  const threadsResult = usePluginData<CompanionThread[]>("threads", { companyId });
  const threadResult = usePluginData<{ thread: CompanionThread; messages: CompanionMessage[] }>(
    "thread",
    activeThreadId ? { companyId, threadId: activeThreadId } : undefined,
  );
  const replyStream = usePluginStream<{ threadId: string; message: CompanionMessage }>("companion-reply", { companyId: companyId ?? undefined });

  const createThreadAction = usePluginAction("create-thread");
  const sendMessageAction = usePluginAction("send-message");
  const proposeActionAction = usePluginAction("propose-action");
  const decideProposalAction = usePluginAction("decide-proposal");

  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!activeThreadId && threadsResult.data && threadsResult.data.length > 0) {
      setActiveThreadId(threadsResult.data[0].id);
    }
  }, [activeThreadId, threadsResult.data]);

  useEffect(() => {
    if (replyStream.lastEvent && replyStream.lastEvent.threadId === activeThreadId) {
      threadResult.refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replyStream.lastEvent]);

  if (!companyId) {
    return (
      <div style={{ padding: 24 }}>
        <p>Select a company to use Paperclip Companion.</p>
      </div>
    );
  }

  if (!host.userId) {
    return (
      <div style={{ padding: 24 }}>
        <p>You must be signed in as an authenticated human user to use Paperclip Companion.</p>
      </div>
    );
  }

  async function handleCreateThread() {
    try {
      const thread = (await createThreadAction({ title: "New conversation" })) as CompanionThread;
      threadsResult.refresh();
      setActiveThreadId(thread.id);
    } catch (err) {
      toast({ title: "Could not start a new conversation", tone: "error", body: String(err) });
    }
  }

  async function handleSend() {
    if (!activeThreadId || !composerValue.trim()) return;
    setSending(true);
    const body = composerValue;
    setComposerValue("");
    try {
      await sendMessageAction({ threadId: activeThreadId, body });
      threadResult.refresh();
    } catch (err) {
      toast({ title: "Companion could not respond", tone: "error", body: String(err) });
    } finally {
      setSending(false);
    }
  }

  async function handlePropose(messageId: string, summary: string) {
    if (!activeThreadId) return;
    try {
      const proposal = (await proposeActionAction({
        threadId: activeThreadId,
        messageId,
        summary,
      })) as CompanionActionProposal;
      setProposals((prev) => ({ ...prev, [messageId]: proposal }));
    } catch (err) {
      toast({ title: "Could not create action proposal", tone: "error", body: String(err) });
    }
  }

  async function handleDecide(proposalId: string, action: "accept" | "reject") {
    try {
      const updated = (await decideProposalAction({ proposalId, action })) as CompanionActionProposal;
      setProposals((prev) => {
        const next = { ...prev };
        for (const key of Object.keys(next)) {
          if (next[key].id === proposalId) next[key] = updated;
        }
        return next;
      });
    } catch (err) {
      toast({ title: "Approval could not be recorded", tone: "error", body: String(err) });
    }
  }

  return (
    <div style={CONTAINER_STYLE}>
      <div style={SIDEBAR_STYLE}>
        <button onClick={handleCreateThread} style={{ width: "100%", marginBottom: 8 }}>
          + New conversation
        </button>
        {threadsResult.loading && <div>Loading…</div>}
        {threadsResult.error && <div style={{ color: "crimson" }}>Could not load conversations.</div>}
        {threadsResult.data && threadsResult.data.length === 0 && <div style={{ opacity: 0.7 }}>No conversations yet.</div>}
        {threadsResult.data?.map((t) => (
          <div
            key={t.id}
            onClick={() => setActiveThreadId(t.id)}
            style={{
              padding: 8,
              borderRadius: 4,
              cursor: "pointer",
              background: t.id === activeThreadId ? "var(--accent-muted, #eef)" : "transparent",
            }}
          >
            {t.title}
          </div>
        ))}
      </div>
      <div style={MAIN_STYLE}>
        <div style={HEADER_STYLE}>
          <h2 style={{ margin: 0 }}>Paperclip Companion</h2>
          <CompanionBadge />
        </div>
        {!activeThreadId && <div style={{ opacity: 0.7 }}>Start a new conversation to ask Companion about source, deployment, or runtime state.</div>}
        {activeThreadId && threadResult.loading && <div>Loading conversation…</div>}
        {activeThreadId && threadResult.error && <div style={{ color: "crimson" }}>Could not load this conversation.</div>}
        {activeThreadId && threadResult.data && (
          <>
            <div style={MESSAGES_STYLE}>
              {threadResult.data.messages.length === 0 && (
                <div style={{ opacity: 0.7 }}>
                  No messages yet. Ask a question like "What commit is Paperclip currently running, what is the synchronized target, and what remains
                  before deployment?"
                </div>
              )}
              {threadResult.data.messages.map((m) => (
                <div key={m.id} style={{ alignSelf: m.role === "human" ? "flex-end" : "flex-start", maxWidth: "80%" }}>
                  <div
                    style={{
                      padding: 10,
                      borderRadius: 8,
                      background: m.role === "human" ? "var(--accent, #eef)" : "var(--surface-alt, #f5f5f5)",
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {m.role === "companion" && <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4, opacity: 0.7 }}>Companion</div>}
                    {m.body}
                  </div>
                  {m.role === "companion" && <EvidenceList evidence={m.evidence} />}
                  {m.role === "companion" && !proposals[m.id] && (
                    <button
                      style={{ marginTop: 6, fontSize: 12 }}
                      onClick={() => handlePropose(m.id, `Follow up on: ${m.body.slice(0, 140)}`)}
                    >
                      Propose next action from this reply
                    </button>
                  )}
                  {proposals[m.id] && <ActionProposalCard proposal={proposals[m.id]} onDecide={handleDecide} />}
                </div>
              ))}
              {sending && <div style={{ opacity: 0.6 }}>Companion is thinking…</div>}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <textarea
                value={composerValue}
                onChange={(e) => setComposerValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
                placeholder="Ask Companion…"
                rows={2}
                style={{ flex: 1 }}
                disabled={sending}
              />
              <button onClick={() => void handleSend()} disabled={sending || !composerValue.trim()}>
                Send
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default CompanionPage;
