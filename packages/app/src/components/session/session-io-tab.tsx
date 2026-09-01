import { createEffect, createMemo, For, Match, on, onCleanup, Show, Switch } from "solid-js"
import type { JSX } from "solid-js"
import type {
  AssistantMessage,
  Message,
  Part,
  ReasoningPart,
  StepFinishPart,
  TextPart,
  ToolPart,
} from "@opencode-ai/sdk/v2/client"
import { Accordion } from "@opencode-ai/ui/accordion"
import { StickyAccordionHeader } from "@opencode-ai/ui/sticky-accordion-header"
import { Icon } from "@opencode-ai/ui/icon"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import { useLanguage } from "@/context/language"
import { useSync } from "@/context/sync"
import { useSessionLayout } from "@/pages/session/session-layout"

const emptyMessages: Message[] = []

function JsonBlock(props: { label: JSX.Element; value: string; tone?: "default" | "error" }) {
  return (
    <div class="flex flex-col gap-1 min-w-0">
      <div class="text-11-regular text-text-weak">{props.label}</div>
      <pre
        class="text-11-regular whitespace-pre-wrap break-words font-mono border border-border-weaker-base rounded-md bg-background-stronger px-2 py-1.5 overflow-x-auto"
        classList={{ "text-error": props.tone === "error" }}
      >
        {props.value}
      </pre>
    </div>
  )
}

function ToolCallCard(props: { part: ToolPart }) {
  const language = useLanguage()
  const state = () => props.part.state
  const input = () => JSON.stringify(state().input, null, 2)
  const duration = () => {
    const s = state()
    if (s.status !== "completed" && s.status !== "error") return undefined
    if (!s.time?.start || !s.time.end) return undefined
    return `${s.time.end - s.time.start}ms`
  }
  const output = () => {
    const s = state()
    return s.status === "completed" ? s.output : undefined
  }
  const error = () => {
    const s = state()
    return s.status === "error" ? s.error : undefined
  }
  return (
    <div class="border border-border-base rounded-md bg-surface-base px-3 py-2 flex flex-col gap-2 min-w-0">
      <div class="flex items-center justify-between gap-2 min-w-0">
        <div class="flex items-center gap-1.5 min-w-0">
          <Icon name="code-lines" size="small" class="shrink-0 text-text-weak" />
          <span class="truncate font-mono text-12-medium text-text-base">{props.part.tool}</span>
          <span class="shrink-0 truncate text-11-regular text-text-weaker">{props.part.callID}</span>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <Show when={duration()}>
            <span class="text-11-regular text-text-weaker">{duration()}</span>
          </Show>
          <Switch>
            <Match when={state().status === "completed"}>
              <span class="size-1.5 shrink-0 rounded-full bg-syntax-success" aria-hidden />
            </Match>
            <Match when={state().status === "error"}>
              <span class="size-1.5 shrink-0 rounded-full bg-syntax-warning" aria-hidden />
            </Match>
            <Match when={state().status === "running" || state().status === "pending"}>
              <span class="size-1.5 shrink-0 rounded-full bg-text-weaker" aria-hidden />
            </Match>
          </Switch>
        </div>
      </div>
      <JsonBlock label={language.t("session.io.input")} value={input()} />
      <Show when={output() !== undefined}>
        <JsonBlock label={language.t("session.io.output")} value={output() ?? ""} />
      </Show>
      <Show when={error() !== undefined}>
        <JsonBlock label={language.t("session.io.error")} value={error() ?? ""} tone="error" />
      </Show>
    </div>
  )
}

function ReasoningBlock(props: { part: ReasoningPart }) {
  const language = useLanguage()
  return (
    <div class="flex flex-col gap-1 min-w-0">
      <div class="text-11-regular text-text-weak">{language.t("session.io.reasoning")}</div>
      <div class="text-11-regular text-text-weaker whitespace-pre-wrap break-words border-l border-border-weaker-base pl-2">
        {props.part.text}
      </div>
    </div>
  )
}

function StepFinishBlock(props: { part: StepFinishPart }) {
  const language = useLanguage()
  const tokens = () => props.part.tokens
  return (
    <div class="flex items-center gap-2 text-11-regular text-text-weak">
      <span>
        {language.t("session.io.tokens", {
          input: tokens().input.toLocaleString(language.intl()),
          output: tokens().output.toLocaleString(language.intl()),
        })}
      </span>
      <Show when={props.part.reason}>
        <span class="text-text-weaker">• {props.part.reason}</span>
      </Show>
    </div>
  )
}

function AssistantTurn(props: {
  message: AssistantMessage
  parts: Part[]
  time: (value: number | undefined) => string
}) {
  const language = useLanguage()
  const label = () => {
    const parts: string[] = [props.message.agent]
    if (props.message.modelID) parts.push(props.message.modelID)
    return parts.join(" • ")
  }
  const hasBody = () =>
    props.parts.some(
      (part) =>
        part.type === "text" ||
        part.type === "reasoning" ||
        part.type === "tool" ||
        part.type === "step-finish",
    )
  return (
    <Accordion.Item value={props.message.id}>
      <StickyAccordionHeader>
        <Accordion.Trigger>
          <div class="flex items-center justify-between gap-2 w-full">
            <div class="min-w-0 truncate text-12-medium">{label()}</div>
            <div class="flex items-center gap-3">
              <div class="shrink-0 text-12-regular text-text-weak">{props.time(props.message.time.created)}</div>
              <Icon name="chevron-grabber-vertical" size="small" class="shrink-0 text-text-weak" />
            </div>
          </div>
        </Accordion.Trigger>
      </StickyAccordionHeader>
      <Accordion.Content class="bg-background-base">
        <Show when={hasBody()} fallback={<div class="px-3 py-2 text-11-regular text-text-weak" />}>
          <div class="flex flex-col gap-3 p-3 min-w-0">
            <For each={props.parts}>
              {(part) => (
                <Switch>
                  <Match when={part.type === "text"}>
                    <Markdown
                      text={(part as TextPart).text}
                      class="text-12-regular prose-sm max-w-none break-words"
                    />
                  </Match>
                  <Match when={part.type === "reasoning"}>
                    <ReasoningBlock part={part as ReasoningPart} />
                  </Match>
                  <Match when={part.type === "tool"}>
                    <ToolCallCard part={part as ToolPart} />
                  </Match>
                  <Match when={part.type === "step-finish"}>
                    <StepFinishBlock part={part as StepFinishPart} />
                  </Match>
                </Switch>
              )}
            </For>
          </div>
        </Show>
      </Accordion.Content>
    </Accordion.Item>
  )
}

export function SessionIOTab() {
  const sync = useSync()
  const language = useLanguage()
  const { params, view } = useSessionLayout()

  const messages = createMemo(
    () => {
      const id = params.id
      if (!id) return emptyMessages
      return (sync().data.message[id] ?? []) as Message[]
    },
    emptyMessages,
  )

  const turns = createMemo(
    () => messages().filter((m): m is AssistantMessage => m.role === "assistant"),
    emptyMessages,
  )

  const getParts = (id: string) => (sync().data.part[id] ?? []) as Part[]
  const time = (value: number | undefined) => {
    if (!value) return "—"
    return new Date(value).toLocaleTimeString(language.intl(), { hour: "2-digit", minute: "2-digit", second: "2-digit" })
  }

  let scroll: HTMLDivElement | undefined
  let frame: number | undefined
  let pending: { x: number; y: number } | undefined

  const restoreScroll = () => {
    const el = scroll
    if (!el) return
    const s = view().scroll("io")
    if (!s) return
    if (el.scrollTop !== s.y) el.scrollTop = s.y
    if (el.scrollLeft !== s.x) el.scrollLeft = s.x
  }

  const handleScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    pending = { x: event.currentTarget.scrollLeft, y: event.currentTarget.scrollTop }
    if (frame !== undefined) return
    frame = requestAnimationFrame(() => {
      frame = undefined
      const next = pending
      pending = undefined
      if (!next) return
      view().setScroll("io", next)
    })
  }

  createEffect(
    on(
      () => turns().length,
      () => {
        requestAnimationFrame(restoreScroll)
      },
      { defer: true },
    ),
  )

  onCleanup(() => {
    if (frame !== undefined) cancelAnimationFrame(frame)
  })

  return (
    <ScrollView
      class="@container h-full"
      viewportRef={(el) => {
        scroll = el
        restoreScroll()
      }}
      onScroll={handleScroll}
    >
      <div class="px-4 pt-3 pb-10">
        <Show
          when={turns().length > 0}
          fallback={
            <div class="px-2 py-2 text-12-regular text-text-weak">{language.t("session.io.empty")}</div>
          }
        >
          <Accordion multiple>
            <For each={turns()}>
              {(message) => <AssistantTurn message={message} parts={getParts(message.id)} time={time} />}
            </For>
          </Accordion>
        </Show>
      </div>
    </ScrollView>
  )
}
