"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowUpRight, ChevronLeft, Clock, Copy, Ellipsis, Pencil, SquarePen, Trash2 } from "lucide-react";
import { defaultModelId, useModels } from "@/components/common/model-picker";
import { useApp } from "@/components/layout/app-context";
import type { ChatAttachment, ChatTransport } from "@/components/studio/chat-client";
import { streamAgentChat } from "@/components/studio/chat-client";
import { Composer } from "@/components/studio/composer";
import { ConfirmDialog, SaveToProjectDialog } from "@/components/studio/dialogs";
import { StudioHeader, useStudio } from "@/components/studio/frame";
import { makeLocalHistory, makeServerHistory, type ConvSummary, type Msg } from "@/components/studio/history";
import { ConversationPane } from "@/components/studio/thread";
import { iconButtonClass, Menu, MenuItem, MenuLabel, MenuSeparator } from "@/components/studio/ui";
import { useStudioChat } from "@/components/studio/use-chat";
import type { AgentInput } from "@/lib/agents/schema";
import { CAPABILITY_INFO, type AgentConfig, type CapabilityStatus } from "@/lib/agents/types";
import { cn, relativeTime } from "@/lib/utils";
import { AgentEditor } from "./agent-editor";
import { AgentAvatar, CAPABILITY_ICONS } from "./agent-visuals";
import { agentChatsKey, agentStatus, deleteAgent, findAgent, toInput, useAgents } from "./use-agents";

const focusInput = () => requestAnimationFrame(() => document.getElementById("studio-input")?.focus());

export function AgentWorkspace({ id }: { id: string }) {
  const state = useAgents();
  const agent = findAgent(state, id);

  if (state.status === "loading") {
    return (
      <>
        <StudioHeader>
          <BackLink />
        </StudioHeader>
        <div className="mx-auto flex w-full max-w-[728px] flex-col items-center px-4 pt-[14vh]" aria-label="Loading agent">
          <div className="s-skeleton h-16 w-16 rounded-[20px]" />
          <div className="s-skeleton mt-6 h-8 w-64" />
          <div className="s-skeleton mt-3 h-4 w-80 max-w-full" />
        </div>
      </>
    );
  }
  if (state.status === "error" || !agent) {
    return (
      <>
        <StudioHeader>
          <BackLink />
        </StudioHeader>
        <div role="alert" className="s-in mx-auto mt-[14vh] flex max-w-sm flex-col items-center px-4 text-center">
          <h1 className="text-[18px] font-semibold">{state.status === "error" ? "Agents couldn’t be loaded" : "Agent not found"}</h1>
          <p className="mt-1.5 text-[14px] text-s-ink-2">
            {state.status === "error" ? state.message : "It may have been deleted, or it was created in another browser."}
          </p>
          <Link href="/agents" className="mt-5 rounded-xl border border-s-line-strong px-4 py-2 text-[13.5px] font-medium transition hover:bg-s-hover">
            Back to agents
          </Link>
        </div>
      </>
    );
  }
  return <AgentConversation key={agent.id} agent={agent} capabilities={state.capabilities} persistence={state.persistence} />;
}

function BackLink() {
  return (
    <Link href="/agents" className="inline-flex h-9 shrink-0 items-center gap-1 rounded-xl pl-1.5 pr-2.5 text-[13.5px] text-s-ink-2 transition hover:bg-s-hover hover:text-s-ink">
      <ChevronLeft className="h-4 w-4" />
      <span className="hidden sm:inline">Agents</span>
    </Link>
  );
}

function AgentConversation({ agent, capabilities, persistence }: { agent: AgentConfig; capabilities: CapabilityStatus; persistence: "server" | "local" }) {
  const router = useRouter();
  const { user, integrations } = useApp();
  const studio = useStudio();
  const demo = !integrations.openai && !integrations.huggingface;
  const basePath = `/agents/${agent.id}`;

  // This agent's own conversation history, separate from ordinary chats.
  const store = useMemo(
    () => (persistence === "server" ? makeServerHistory(`/api/agents/${agent.id}/conversations`) : makeLocalHistory(agentChatsKey(agent.id))),
    [persistence, agent.id],
  );
  const [conversations, setConversations] = useState<ConvSummary[] | null>(null);
  const refreshConversations = useCallback(async () => {
    try {
      setConversations(await store.list());
    } catch {
      setConversations([]);
    }
  }, [store]);
  useEffect(() => {
    let alive = true;
    store
      .list()
      .then((c) => alive && setConversations(c))
      .catch(() => alive && setConversations([]));
    return () => {
      alive = false;
    };
  }, [store]);

  // Model: the agent's preferred model when available; the user may switch for this session.
  const models = useModels();
  const [picked, setPicked] = useState<string | null>(null);
  const preferred = agent.modelId && models?.some((m) => m.id === agent.modelId && m.available) ? agent.modelId : undefined;
  const modelId = picked ?? preferred ?? defaultModelId(models);

  // Guests' custom agents live in the browser, so their config travels with each request.
  const transport = useCallback<ChatTransport>(
    (req, signal) =>
      streamAgentChat(
        {
          agentId: agent.id,
          conversationId: req.conversationId,
          message: req.message,
          modelId: picked ?? undefined,
          useWeb: req.useWeb,
          history: req.history,
          attachments: req.attachments,
          agent: agent.kind === "custom" && persistence === "local" ? toInput(agent) : undefined,
        },
        signal,
      ),
    [agent, persistence, picked],
  );

  const chat = useStudioChat({ store, defaultMode: "research", modelId, onHistoryChanged: refreshConversations, basePath, transport });

  const [input, setInput] = useState(() => studio.takePendingPrompt() ?? "");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [toSave, setToSave] = useState<Msg | null>(null);
  const [editor, setEditor] = useState<{ editing: AgentConfig | null; draft: AgentInput | null } | null>(null);
  const [confirm, setConfirm] = useState<"agent" | "conversation" | null>(null);

  const { on } = studio;
  useEffect(
    () =>
      on<string>("use-prompt", (text) => {
        setInput(text);
        focusInput();
      }),
    [on],
  );

  const canWeb = agent.capabilities.includes("web_search");
  const canFiles = agent.capabilities.includes("file_analysis");
  const status = agentStatus(agent, capabilities, models, demo);

  const send = (text: string, files: ChatAttachment[] = []) => {
    setAnalyzing(agent.capabilities.includes("data_analysis") && files.some((f) => /\.(csv|tsv)$/i.test(f.name)));
    void chat.send(text, { attachments: files });
  };
  const submit = () => {
    if (!input.trim() || chat.busy) return;
    const text = input;
    const files = attachments;
    setInput("");
    setAttachments([]);
    send(text, files);
  };
  const newConversation = () => {
    chat.newChat();
    setInput("");
    setAttachments([]);
    focusInput();
  };

  const empty = chat.messages.length === 0 && chat.load.status === "idle";
  const composer = (variant: "hero" | "dock") => (
    <Composer
      variant={variant}
      value={input}
      onChange={setInput}
      onSubmit={submit}
      busy={chat.busy}
      onStop={chat.stop}
      attachments={attachments}
      onAttachments={setAttachments}
      models={models}
      modelId={modelId}
      onModel={setPicked}
      mode={chat.mode}
      useWeb={chat.useWeb}
      onUseWeb={chat.setUseWeb}
      webAvailable={capabilities.web_search.available}
      webAllowed={canWeb}
      webBlockedHint="Not enabled for this agent"
      filesAllowed={canFiles}
      placeholder={`Message ${agent.name}`}
      enterToSend={studio.settings.enterToSend}
    />
  );

  return (
    <>
      <StudioHeader
        onNewChat={newConversation}
        actions={
          <>
            <Menu
              label={`${agent.name} conversations`}
              align="end"
              width={300}
              buttonLabel="Conversation history"
              buttonClassName={iconButtonClass()}
              button={<Clock />}
            >
              <MenuLabel>Conversations with {agent.name}</MenuLabel>
              <MenuItem icon={<SquarePen />} onClick={newConversation}>
                New conversation
              </MenuItem>
              {conversations && conversations.length > 0 && <MenuSeparator />}
              {conversations === null ? (
                <p className="px-2.5 py-2 text-[13px] text-s-ink-3">Loading…</p>
              ) : conversations.length === 0 ? (
                <p className="px-2.5 py-2 text-[13px] text-s-ink-3">No conversations yet.</p>
              ) : (
                conversations.map((c) => (
                  <MenuItem
                    key={c.id}
                    role="menuitemradio"
                    checked={c.id === chat.conversationId}
                    hint={relativeTime(c.updated_at)}
                    onClick={() => router.push(`${basePath}?c=${c.id}`)}
                  >
                    {c.title}
                  </MenuItem>
                ))
              )}
            </Menu>
            <Menu label={`${agent.name} options`} align="end" width={250} buttonLabel="Agent options" buttonClassName={iconButtonClass()} button={<Ellipsis />}>
              {agent.kind === "custom" ? (
                <MenuItem icon={<Pencil />} onClick={() => setEditor({ editing: agent, draft: null })}>
                  Edit agent
                </MenuItem>
              ) : (
                <MenuItem
                  icon={<Pencil />}
                  hint="Built-in agents can’t be changed; edit a copy"
                  onClick={() => setEditor({ editing: null, draft: { ...toInput(agent), name: `${agent.name} (copy)` } })}
                >
                  Customize a copy
                </MenuItem>
              )}
              {agent.kind === "custom" && (
                <MenuItem icon={<Copy />} onClick={() => setEditor({ editing: null, draft: { ...toInput(agent), name: `${agent.name} (copy)`.slice(0, 80) } })}>
                  Duplicate
                </MenuItem>
              )}
              <MenuItem icon={<SquarePen />} onClick={newConversation}>
                New conversation
              </MenuItem>
              {(chat.conversationId || agent.kind === "custom") && <MenuSeparator />}
              {chat.conversationId && (
                <MenuItem icon={<Trash2 />} danger onClick={() => setConfirm("conversation")}>
                  Delete this conversation
                </MenuItem>
              )}
              {agent.kind === "custom" && (
                <MenuItem icon={<Trash2 />} danger onClick={() => setConfirm("agent")}>
                  Delete agent
                </MenuItem>
              )}
            </Menu>
          </>
        }
      >
        <BackLink />
        <span className="hidden h-5 w-px bg-s-line-strong sm:block" aria-hidden />
        <AgentAvatar agent={agent} size="sm" />
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-[14px] font-semibold">{agent.name}</h1>
            <span className="hidden shrink-0 rounded-full bg-s-accent-soft px-2 py-px text-[11px] font-medium text-s-accent sm:inline">Agent</span>
          </div>
          <p className="truncate text-[12px] text-s-ink-3">{empty ? (agent.kind === "custom" ? "Custom agent" : agent.category) : (chat.title ?? "New conversation")}</p>
        </div>
      </StudioHeader>

      {empty ? (
        <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex min-h-full w-full max-w-[728px] flex-col items-center justify-center px-4 pb-16 pt-8 sm:px-6">
            <AgentAvatar agent={agent} size="lg" className="s-in" />
            <h2 className="s-in mt-6 text-balance text-center font-serif text-[clamp(32px,5.5vw,46px)] leading-[1.08] tracking-[-0.01em] [animation-delay:60ms]">
              {agent.name}
            </h2>
            <p className="s-in mt-2 flex items-center gap-2 text-[13px] text-s-ink-3 [animation-delay:90ms]">
              {agent.kind === "custom" ? "Custom agent" : agent.category}
              <span aria-hidden>·</span>
              <span className={cn(status.tone === "warn" && "text-[#c98a1c]")}>{status.tone === "warn" ? status.detail : status.label}</span>
            </p>
            {agent.description && (
              <p className="s-in mt-3 max-w-md text-balance text-center text-[15.5px] leading-relaxed text-s-ink-2 [animation-delay:120ms]">{agent.description}</p>
            )}
            <ul className="s-in mt-4 flex flex-wrap justify-center gap-1.5 [animation-delay:150ms]" aria-label="Capabilities">
              {agent.capabilities.length === 0 ? (
                <li className="rounded-full border border-s-line px-2.5 py-1 text-[12px] text-s-ink-3">Conversation only · no tools</li>
              ) : (
                agent.capabilities.map((c) => (
                  <li
                    key={c}
                    title={capabilities[c].available ? CAPABILITY_INFO[c].description : capabilities[c].reason}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border border-s-line px-2.5 py-1 text-[12px] [&_svg]:h-3.5 [&_svg]:w-3.5",
                      capabilities[c].available ? "text-s-ink-2" : "text-s-ink-3",
                    )}
                  >
                    {CAPABILITY_ICONS[c]}
                    {CAPABILITY_INFO[c].label}
                    {!capabilities[c].available && <span className="text-s-ink-3">· needs setup</span>}
                  </li>
                ))
              )}
            </ul>

            <div className="s-in mt-8 w-full [animation-delay:180ms]">{composer("hero")}</div>

            {agent.starters.length > 0 && (
              <ul className="mt-5 grid w-full gap-2 sm:grid-cols-2" aria-label="Suggested prompts">
                {agent.starters.map((s, i) => (
                  <li key={s} className="s-in" style={{ animationDelay: `${220 + i * 40}ms` }}>
                    <button
                      type="button"
                      onClick={() => send(s)}
                      className="group flex h-full w-full items-center justify-between gap-3 rounded-2xl border border-s-line px-4 py-3 text-left text-[13.5px] text-s-ink-2 transition duration-200 hover:border-s-line-strong hover:bg-s-glass hover:text-s-ink active:scale-[0.99]"
                    >
                      {s}
                      <ArrowUpRight className="h-4 w-4 shrink-0 text-s-ink-3 transition group-hover:text-s-accent" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {demo && <p className="s-in mt-7 text-center text-[12.5px] text-s-ink-3 [animation-delay:380ms]">Demo mode: replies are simulated until an AI provider key is added on the server. Tools such as data analysis still run for real.</p>}
          </div>
        </div>
      ) : (
        <ConversationPane
          messages={chat.messages}
          load={chat.load}
          busy={chat.busy}
          conversationId={chat.conversationId}
          composer={composer("dock")}
          footnote={`${agent.name} can make mistakes. Check important information.`}
          thinkingLabel={chat.useWeb && canWeb && capabilities.web_search.available ? "Searching the web" : analyzing ? "Analyzing data" : "Thinking"}
          feedback={studio.feedback}
          onRetry={chat.retry}
          onFeedback={studio.giveFeedback}
          onSavePrompt={studio.addPrompt}
          onSaveToProject={user ? setToSave : undefined}
          onStartOver={newConversation}
          startOverLabel="Start a new conversation"
          assistantName={agent.name}
          assistantAvatar={<AgentAvatar agent={agent} size="xs" />}
        />
      )}

      <SaveToProjectDialog message={toSave} onClose={() => setToSave(null)} />
      <AgentEditor
        open={!!editor}
        editing={editor?.editing ?? null}
        draft={editor?.draft ?? null}
        capabilities={capabilities}
        models={models}
        onClose={() => setEditor(null)}
        onSaved={(saved, created) => {
          setEditor(null);
          studio.notify(created ? `${saved.name} created` : "Changes saved");
          if (created) router.push(`/agents/${saved.id}`);
        }}
      />
      <ConfirmDialog
        open={confirm !== null}
        title={confirm === "agent" ? `Delete ${agent.name}?` : "Delete this conversation?"}
        description={
          confirm === "agent" ? "The agent and all of its conversations will be permanently deleted." : `“${chat.title ?? "This conversation"}” will be permanently deleted.`
        }
        confirmLabel={confirm === "agent" ? "Delete agent" : "Delete"}
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          if (confirm === "agent") {
            await deleteAgent(agent.id);
            studio.notify("Agent deleted");
            router.push("/agents");
          } else if (chat.conversationId) {
            await store.remove(chat.conversationId);
            newConversation();
            await refreshConversations();
            studio.notify("Conversation deleted");
          }
        }}
      />
    </>
  );
}
