import { createEffect, createMemo, onCleanup, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { HoverCard } from "@opencode-ai/ui/hover-card"
import { Icon } from "@opencode-ai/ui/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { useI18n } from "@opencode-ai/ui/context/i18n"

export interface TaskToolHoverCardProps {
  trigger: JSX.Element
  agent?: string
  agentColor?: string
  model?: string
  running: boolean
  done: boolean
  failed: boolean
  background?: boolean
  start?: number
  end?: number
  result?: string
}

function durationText(ms: number, format: Intl.NumberFormat, t: ReturnType<typeof useI18n>["t"]) {
  const total = Math.round(ms / 1000)
  if (total < 60) return t("ui.message.duration.seconds", { count: format.format(total) })
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return t("ui.message.duration.minutesSeconds", {
    minutes: format.format(minutes),
    seconds: format.format(seconds),
  })
}

export function TaskToolHoverCard(props: TaskToolHoverCardProps) {
  const i18n = useI18n()
  const numfmt = createMemo(() => new Intl.NumberFormat(i18n.locale()))
  const [state, setState] = createStore({ now: Date.now() })

  let interval: ReturnType<typeof setInterval> | undefined
  createEffect(() => {
    if (props.running && props.start) {
      if (interval) return
      setState("now", Date.now())
      interval = setInterval(() => setState("now", Date.now()), 1000)
      return
    }
    if (interval) {
      clearInterval(interval)
      interval = undefined
    }
  })
  onCleanup(() => {
    if (interval) clearInterval(interval)
  })

  const elapsed = () => {
    if (props.running && props.start) return Math.max(0, state.now - props.start)
    if ((props.done || props.failed) && props.start && props.end) return Math.max(0, props.end - props.start)
    return 0
  }

  const statusLabel = () => {
    if (props.running) return i18n.t("ui.tool.task.hover.running")
    if (props.done) return i18n.t("ui.tool.task.hover.done")
    if (props.failed) return i18n.t("ui.tool.task.hover.failed")
    return i18n.t("ui.tool.task.hover.pending")
  }

  const duration = createMemo(() => {
    const ms = elapsed()
    if (ms <= 0) return ""
    return durationText(ms, numfmt(), i18n.t)
  })

  const resultText = createMemo(() => {
    const text = props.result?.trim()
    if (!text) return ""
    return text.length > 240 ? `${text.slice(0, 240).trimEnd()}\u2026` : text
  })

  const hasMeta = () => !!props.agent || !!props.model

  return (
    <HoverCard openDelay={150} closeDelay={0} placement="top" class="task-hover-card" trigger={props.trigger}>
      <div data-component="task-hover">
        <div data-slot="task-hover-status" data-state={props.running ? "running" : props.failed ? "error" : "done"}>
          <Show when={props.running}>
            <Spinner class="task-hover-spinner" />
          </Show>
          <Show when={props.done}>
            <Icon name="circle-check" size="small" />
          </Show>
          <Show when={props.failed}>
            <Icon name="circle-x" size="small" />
          </Show>
          <span data-slot="task-hover-status-label">{statusLabel()}</span>
          <Show when={duration()}>
            <span data-slot="task-hover-duration">{i18n.t("ui.tool.task.hover.in", { time: duration() })}</span>
          </Show>
          <Show when={props.background}>
            <span data-slot="task-hover-background">{i18n.t("ui.tool.task.hover.background")}</span>
          </Show>
        </div>
        <Show when={hasMeta()}>
          <div data-slot="task-hover-meta">
            <Show when={props.agent}>
              <span data-slot="task-hover-agent" style={props.agentColor ? { color: props.agentColor } : undefined}>
                {props.agent}
              </span>
            </Show>
            <Show when={props.agent && props.model}>
              <span data-slot="task-hover-separator" aria-hidden>
                {"\u00B7"}
              </span>
            </Show>
            <Show when={props.model}>
              <span data-slot="task-hover-model">{props.model}</span>
            </Show>
          </div>
        </Show>
        <Show when={resultText()}>
          <div data-slot="task-hover-result">
            <span data-slot="task-hover-result-label">{i18n.t("ui.tool.task.hover.result")}</span>
            <p data-slot="task-hover-result-text">{resultText()}</p>
          </div>
        </Show>
      </div>
    </HoverCard>
  )
}
