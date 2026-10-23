// Archivist for Claude Code, as a mod: journals each task, analyses it once the session goes quiet,
// writes the knowledge back into the project and reports what it learned.
//
// Bundled by scripts/build.mjs into plugin/hooks/register.js. Rules of the mods runtime that shape this file:
//   - no Node: every outside effect goes through `$`;
//   - `$` may only be passed to functions declared at the top level of this file;
//   - work that must outlive a hook's dispatch runs on `$.clock.after`; a module reload drops timers,
//     so the open task is kept in `$.store` after every turn and picked up again on `session.start`.
import type { On } from 'claude-code'
import { DEFAULT_CONFIG, loadConfig, type Config } from '../../../core/config.js'
import { PATHS, joinPath, relPath, withLocalIgnored, type Io, type Llm, type LlmReply } from '../../../core/io.js'
import { activeEntries, loadState } from '../../../core/ledger.js'
import { isExcluded, redact } from '../../../core/privacy.js'
import { applyProposals, deprecateEntry, describeOp, editEntry, editFromOptions, listProposals, pick, reviewText, skipProposals } from '../../../core/review.js'
import { parseOptions, splitArgs } from '../../../core/args.js'
import { healthText, memoryLines, recallText, statsText } from '../../../core/maintenance.js'
import { clearMemory, loadMemoryCaches, memoryOutcomeText, memoryUpToDate, projectId, syncMemory, type MemoryStore } from '../../../core/memory.js'
import { findOpenVikingServer, openVikingStore, type McpCall } from '../../../core/memory-openviking.js'
import { logKey, withLine } from '../../../core/log.js'
import { countsText, shouldRecount, type StatusKind } from '../../../core/status.js'
import { truncate } from '../../../core/text.js'
import { addUsage, emptyUsage, weightedTokens, type Message, type Segment, type ToolEvent, type Usage } from '../../../core/types.js'
import { analyzeSegment } from '../../../analyzer/pipeline.js'
import { afterFailure, MAX_FAILURES } from '../../../core/attempts.js'
import { holdOf, type RateLimit } from '../../../core/hold.js'
import { noticeText, statusLine } from '../../../analyzer/report.js'

const SEG_KEY = 'archivist:seg:'
const BUDGET_KEY = 'archivist:budget:'
const LAST_KEY = 'archivist:last:'
/** Wait before trying again when a budget or rate limit held the analysis back. */
const RETRY_MS = 15 * 60_000
const BUSY_RETRY_MS = 60_000
const FORK_TIMEOUT_MS = 120_000
const MEMORY_CHECK_AFTER_START_MS = 5_000
const NO_MEMORY = 'No supported memory plugin is connected to this session (Archivist supports OpenViking).'

interface StoredSegment {
  root: string
  seg: Segment
  failures?: number
}

/** One store key per task, so a task waiting for analysis is never overwritten by the next one. */
const segKey = (s: Segment): string => `${SEG_KEY}${s.session}:${s.id}`

interface ModUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

const toUsage = (u: ModUsage | undefined): Usage => ({
  input: u?.input_tokens ?? 0,
  output: u?.output_tokens ?? 0,
  cacheRead: u?.cache_read_input_tokens ?? 0,
  cacheWrite: u?.cache_creation_input_tokens ?? 0,
})

const today = (): string => new Date().toISOString().slice(0, 10)

/** What the journal keeps of a tool call: its target, never its content; nothing at all for an excluded file. */
const toolTarget = (root: string, tool: string, input: unknown, exclude: string[]): string | undefined => {
  const i = (input ?? {}) as Record<string, unknown>
  const v = i.file_path ?? i.notebook_path ?? i.command ?? i.pattern ?? i.path ?? i.url
  if (typeof v !== 'string') return undefined
  if (tool === 'Bash') return redact(truncate(v.replace(/\s+/g, ' ').trim(), 200)).text
  const rel = relPath(root, v)
  return isExcluded(rel, exclude) ? undefined : rel
}

// ── state of this module copy (reset on reload; the open segment is restored from $.store) ──
let root = ''
let session = ''
let cfg: Config = DEFAULT_CONFIG
let seg: Segment | undefined
let idle: { cancel: () => void } | undefined
let analysing = false
let notice: string | undefined
let ownTurnPending = false
/** The status line as last set, and what kind of message it is (see core/status.ts). */
let lastStatus: string | undefined
let statusKind: StatusKind | undefined
const ownTurns = new Set<string>()
let memoryBusy = false
let memoryAgain: 'fast' | 'verify' | undefined

const newSegment = (): Segment => ({
  id: Date.now().toString(36),
  session,
  startedAt: Date.now(),
  prompts: [],
  answers: [],
  turns: [],
  tools: [],
  rulesLoaded: [],
})

function makeIo($: any, base: string): Io {
  const abs = (p: string) => joinPath(base, p)
  return withLocalIgnored({
    root: base,
    async read(p) {
      return (await $.fs.exists(abs(p))) ? await $.fs.read(abs(p)) : undefined
    },
    async write(p, text) {
      // $.fs.write creates missing directories itself.
      await $.fs.write(abs(p), text)
    },
    async remove(p) {
      // $.fs has no delete: the generated file goes through the shell.
      await $.process.run(['rm', '-f', abs(p)])
    },
    async removeEmptyDir(p) {
      // rmdir refuses a directory that still holds anything: only an emptied one goes.
      await $.process.run(['rmdir', abs(p)])
    },
    async exists(p) {
      return await $.fs.exists(abs(p))
    },
    async list(dir) {
      if (!(await $.fs.exists(abs(dir)))) return []
      const entries = (await $.fs.list(abs(dir))) as { name: string }[]
      return entries.map((e) => e.name)
    },
    mutex: {
      async claim(p) {
        await $.process.run(['mkdir', '-p', abs(p).replace(/\/[^/]+$/, '')])
        return (await $.process.run(['mkdir', abs(p)])).exitCode === 0
      },
      async age(p) {
        try {
          return Date.now() - (await $.fs.stat(abs(p))).mtimeMs
        } catch {
          return undefined
        }
      },
      async release(p) {
        await $.process.run(['rmdir', abs(p)])
      },
      async sleep(ms) {
        await $.clock.sleep(ms)
      },
    },
  })
}

/** Diagnostics kept in the mod's store, one log per project (`/archivist log`): the analysis runs where no one watches. */
async function log($: any, project: string, line: string): Promise<void> {
  const key = logKey(project)
  await $.store.set(key, withLine((await $.store.get(key)) as string[] | undefined, line, new Date()))
}

function makeLlm($: any, config: Config): Llm {
  const reply = (r: any): LlmReply =>
    r.isAnswered ? { ok: true, text: r.text, usage: toUsage(r.usage) } : { ok: false, reason: String(r.reason), usage: toUsage(r.usage) }
  return {
    async reflect(prompt) {
      // fork takes no time limit of its own; a hung call would hold the analysis lock forever.
      const timeout = $.clock.sleep(FORK_TIMEOUT_MS).then(() => ({ isAnswered: false, reason: 'timeout' }))
      return reply(await Promise.race([$.model.fork({ prompt }), timeout]))
    },
    async complete({ system, prompt, maxTokens }) {
      return reply(
        await $.model.complete({
          model: config.analyzer.curateModel,
          system: [{ text: system, cache: true }],
          prompt,
          maxTokens,
          timeoutMs: 120_000,
        }),
      )
    },
  }
}

async function saveSegment($: any): Promise<void> {
  if (seg) await $.store.set(segKey(seg), { root, seg } satisfies StoredSegment)
}

async function readMessages($: any): Promise<Message[]> {
  const list = (await $.session.messages()) as any[]
  return list.map((m) => ({
    role: m.role,
    text: m.text ?? '',
    toolUses: (m.toolUses ?? []).map((t: any) => ({ tool: t.tool, input: t.input ?? {}, isError: t.isError, text: t.text })),
  }))
}

function showStatus($: any, text: string | undefined, kind: StatusKind): void {
  lastStatus = text
  statusKind = kind
  $.ui.status(text)
}

async function refreshStatus($: any, io: Io): Promise<void> {
  const state = await loadState(io)
  const n = activeEntries(state.entries).length
  const queued = (await listProposals(io)).length
  showStatus($, countsText(n, queued), 'counts')
}

function mcpCaller($: any, server: string): McpCall {
  return async (tool, args) => {
    const reply = await $.mcp.call(server, tool, args)
    const blocks = (reply.content ?? []) as { type: string; text?: string }[]
    return { text: blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n'), isError: Boolean(reply.isError) }
  }
}

async function memoryServer($: any, config: Config): Promise<string | undefined> {
  if (config.memory.server !== 'auto') return config.memory.server
  const usage = await $.session.usage({ breakdown: 'summary' })
  return findOpenVikingServer((usage.context?.breakdown?.mcpTools ?? []) as { name: string; serverName: string }[])
}

async function gitRemote($: any, base: string): Promise<string | undefined> {
  const run = await $.process.run(['git', '-C', base, 'remote', 'get-url', 'origin'])
  return run.exitCode === 0 ? String(run.stdout ?? '').trim() || undefined : undefined
}

async function memoryTarget($: any, base: string, config: Config): Promise<{ server: string; project: string; store: MemoryStore } | undefined> {
  const server = await memoryServer($, config)
  if (!server) return undefined
  const project = config.memory.project !== 'auto' ? config.memory.project : projectId(await gitRemote($, base), base)
  return { server, project, store: openVikingStore(mcpCaller($, server), project) }
}

async function syncToMemory($: any, base: string, mode: 'fast' | 'verify'): Promise<void> {
  if (memoryBusy) {
    memoryAgain = mode === 'verify' || memoryAgain === 'verify' ? 'verify' : 'fast'
    return
  }
  memoryBusy = true
  try {
    const io = makeIo($, base)
    const config = await loadConfig(io)
    if (!config.enabled || !config.memory.enabled) return
    if (mode === 'fast' && (await memoryUpToDate(io))) return
    const target = await memoryTarget($, base, config)
    if (!target) return
    const outcome = await syncMemory({ io, store: target.store, project: target.project, mode, now: new Date().toISOString() })
    if (outcome) await log($, base, `memory ${mode} (${target.server}, ${target.project}): ${memoryOutcomeText(outcome)}`)
  } catch (err) {
    await log($, base, `memory ${mode}: failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    memoryBusy = false
    const again = memoryAgain
    memoryAgain = undefined
    if (again) await syncToMemory($, base, again)
  }
}

function syncToMemoryLater($: any, base: string, mode: 'fast' | 'verify', delayMs = 0): void {
  $.clock.after(delayMs, async () => syncToMemory($, base, mode))
}

async function memoryCommand($: any, io: Io, config: Config, action: string): Promise<string> {
  const target = await memoryTarget($, root, config)
  const where = target ? `${target.server}, project ${target.project}` : ''
  const syncOn = config.enabled && config.memory.enabled
  if (action === 'sync') {
    if (!syncOn) return 'Memory sync is off: set memory.enabled to true in .archivist/config.json.'
    if (!target) return NO_MEMORY
    const outcome = await syncMemory({ io, store: target.store, project: target.project, mode: 'verify', now: new Date().toISOString() })
    return `Synced with ${where}: ${outcome ? memoryOutcomeText(outcome) : 'nothing to do'}.`
  }
  if (action === 'clear') {
    if (!target) return NO_MEMORY
    const removed = await clearMemory(io, target.store, target.project)
    return [
      `Removed ${removed.length} Archivist items from ${where}.`,
      ...(syncOn ? ['Memory sync is still on, so they come back at the next sync: set memory.enabled to false in .archivist/config.json to keep them out.'] : []),
    ].join(' ')
  }
  return [target ? `Memory: ${where}${syncOn ? '' : ' (sync is off: memory.enabled)'}` : NO_MEMORY, ...memoryLines(await loadMemoryCaches(io))].join('\n')
}

/** Runs the pipeline over one finished task. `current` = it belongs to this live session (messages and fork available). */
async function analyse($: any, stored: StoredSegment, current: boolean): Promise<void> {
  const s = stored.seg
  if (analysing) {
    await log($, stored.root, `seg ${s.id}: another analysis is running, retry later`)
    $.clock.after(BUSY_RETRY_MS, async () => analyse($, stored, current))
    return
  }
  analysing = true
  try {
    // A retry or a second schedule may reach a task that has been analysed meanwhile: its key is gone then.
    if (!(await $.store.get(segKey(s)))) {
      await log($, stored.root, `seg ${s.id}: already analysed, skipped`)
      return
    }
    const io = makeIo($, stored.root)
    const config = await loadConfig(io)
    await log($, stored.root, `seg ${s.id}: start (${s.turns.length} turns, ${s.tools.length} tool calls, current=${current})`)
    if (!config.enabled) {
      await $.store.delete(segKey(s))
      await log($, stored.root, `seg ${s.id}: archivist disabled for this project, dropped`)
      return
    }

    const spentKey = BUDGET_KEY + today()
    const spent = ((await $.store.get(spentKey)) as number | undefined) ?? 0
    const usage = await $.session.usage()
    const held = holdOf(spent, (usage.rateLimits ?? []) as RateLimit[], config.analyzer, new Date())
    if (held) {
      await log($, stored.root, `seg ${s.id}: postponed: ${held.reason}`)
      showStatus($, held.status, 'event')
      $.clock.after(RETRY_MS, async () => analyse($, stored, current))
      return
    }

    showStatus($, '📚 analysing the last task…', 'event')
    const result = await analyzeSegment({
      io,
      llm: makeLlm($, config),
      config,
      segment: s,
      ...(current ? { messages: await readMessages($), contextTokens: usage.context?.tokens ?? 0 } : {}),
      now: new Date(),
    })
    // The task is done with, whatever came of it: never analyse it twice.
    await $.store.delete(segKey(s))
    await $.store.set(spentKey, spent + weightedTokens(result.usage))
    await log(
      $,
      stored.root,
      result.kind === 'skipped'
        ? `seg ${s.id}: skipped: ${result.reason}`
        : `seg ${s.id}: done: ${result.report.applied.length} applied, ${result.report.proposals.length} proposals, ` +
            `${result.report.rejected.length} dropped, ${weightedTokens(result.usage)} weighted tokens` +
            `${result.report.analysis.error ? `; ${result.report.analysis.error}` : ''} → ${result.reportPath}`,
    )

    if (result.kind === 'skipped') {
      await refreshStatus($, io)
      return
    }
    await $.store.set(LAST_KEY + stored.root, result.reportPath)
    notice = noticeText(result.report)
    showStatus($, statusLine(result.report), 'result')
    $.ui.toast(statusLine(result.report), { timeoutMs: config.report.toastMs })
    syncToMemoryLater($, stored.root, 'fast')
    if (config.report.mode === 'rewake' && current) {
      ownTurnPending = true
      await $.prompt.submit({
        text: `Archivist report (informational; the task is finished, do not resume it). Tell the user in two or three lines what was recorded:\n\n${notice}`,
      })
    }
  } catch (err) {
    const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)
    const kept = (await $.store.get(segKey(s))) as StoredSegment | undefined
    const { failures, drop } = afterFailure(kept?.failures)
    if (drop) await $.store.delete(segKey(s))
    else if (kept) await $.store.set(segKey(s), { ...kept, failures } satisfies StoredSegment)
    await log(
      $,
      stored.root,
      `seg ${s.id}: failed (${failures}/${MAX_FAILURES}${drop ? ', given up' : ', retried at the next session start'}): ${msg}`,
    )
    showStatus($, '📚 analysis failed: /archivist log', 'event')
  } finally {
    analysing = false
  }
}

export function register(on: On): void {
  on('session.start', async ($, e, next) => {
    root = await $.session.root()
    session = await $.session.id()
    cfg = await loadConfig(makeIo($, root))
    await $.command.register({
      name: 'archivist',
      description: 'Archivist: what it learned from the last task (report) or the knowledge base status (status)',
      argumentHint: '[report|status|health|stats|recall <words>|review|apply <n>|skip <n>|edit <id> …|deprecate <id> --reason …|memory [status|sync|clear]|log]',
    })

    // Tasks waiting for analysis: this session's (a module reload dropped their timer; the open one is closed
    // here) get the full analysis, other sessions' (ended before it ran) only their journal.
    const waiting = new Map<string, { stored: StoredSegment; current: boolean }>()
    for (const key of await $.store.keys()) {
      if (!key.startsWith(SEG_KEY)) continue
      const s = (await $.store.get(key)) as StoredSegment | undefined
      if (s?.root !== root) continue
      if (key !== segKey(s.seg)) {
        await $.store.set(segKey(s.seg), s)
        await $.store.delete(key)
      }
      waiting.set(segKey(s.seg), { stored: s, current: s.seg.session === session })
    }
    if (waiting.size) {
      await log($, root, `session.start: ${waiting.size} task(s) waiting for analysis`)
      const config = await loadConfig(makeIo($, root))
      $.clock.after(config.analyzer.idleSeconds * 1000, async () => {
        for (const w of waiting.values()) await analyse($, w.stored, w.current)
      })
    }
    await refreshStatus($, makeIo($, root))
    syncToMemoryLater($, root, 'verify', MEMORY_CHECK_AFTER_START_MS)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.attach', async ($, e, next) => {
    const r = await next(e)
    // Recount: the queue may have changed outside the mod (a triage through the CLI) while no app was attached.
    if (root && shouldRecount(statusKind)) await refreshStatus($, makeIo($, root))
    else if (lastStatus) $.ui.status(lastStatus)
    return r
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    if (ownTurnPending) {
      ownTurnPending = false
      ownTurns.add(e.turnId)
      return next(e)
    }
    idle?.cancel()
    idle = undefined
    seg ??= newSegment()
    seg.prompts.push(e.text)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.PostToolUse', async ($, e, next) => {
    if (seg) {
      const ev: ToolEvent = { tool: e.tool_name, ok: true }
      const target = toolTarget(root, e.tool_name, e.tool_input, cfg.privacy.excludePaths)
      if (target) ev.target = target
      if (e.duration_ms !== undefined) ev.durationMs = e.duration_ms
      if (e.agent_id) ev.agent = e.agent_id
      seg.tools.push(ev)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.PostToolUseFailure', async ($, e, next) => {
    if (seg && !e.is_interrupt) {
      const ev: ToolEvent = { tool: e.tool_name, ok: false, error: redact(truncate(e.error.replace(/\s+/g, ' '), 300)).text }
      const target = toolTarget(root, e.tool_name, e.tool_input, cfg.privacy.excludePaths)
      if (target) ev.target = target
      if (e.agent_id) ev.agent = e.agent_id
      seg.tools.push(ev)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.InstructionsLoaded', async ($, e, next) => {
    if (seg && e.file_path.includes(PATHS.rulesDir)) {
      const r: { file: string; trigger?: string } = { file: relPath(root, e.file_path) }
      if (e.trigger_file_path) r.trigger = relPath(root, e.trigger_file_path)
      seg.rulesLoaded.push(r)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined || ownTurns.has(e.turnId)) return r
    if (seg) {
      seg.turns.push({ turnId: e.turnId, durationMs: e.durationMs, usage: addUsage(emptyUsage(), toUsage(e.usage)) })
      if (e.answer) seg.answers.push(truncate(e.answer, 2000))
      await saveSegment($)
      const config = (cfg = await loadConfig(makeIo($, root)))
      if (config.enabled) {
        idle?.cancel()
        idle = $.clock.after(config.analyzer.idleSeconds * 1000, async () => {
          idle = undefined
          const s = seg
          if (!s) return
          seg = undefined
          await analyse($, { root, seg: s }, true)
        })
      }
    }
    // The turn may have changed entries or the queue through the CLI (archivist apply/skip/edit, the triage skill):
    // recount. An event (analysing, postponed, failed) stays until the next analysis replaces it.
    if (root && shouldRecount(statusKind)) await refreshStatus($, makeIo($, root))
    else if (lastStatus) $.ui.status(lastStatus)
    if (root) syncToMemoryLater($, root, 'fast')
    if (!notice) return r
    // r.text is the answer itself: replace it with the notice, never append to it, or the answer is shown twice.
    const text = notice
    notice = undefined
    return { ...r, text }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'archivist' }, async ($, e) => {
    const io = makeIo($, root)
    const [verb = 'report', ...rest] = splitArgs(e.args)
    if (verb === 'log') {
      const lines = ((await $.store.get(logKey(root))) as string[] | undefined) ?? []
      return { text: lines.length ? [`Archivist log for ${root}:`, ...lines.slice(-30)].join('\n') : `Archivist log for ${root} is empty.` }
    }
    if (verb === 'review') return { text: reviewText(await listProposals(io)) }
    if (verb === 'edit' || verb === 'deprecate') {
      const { words, opts } = parseOptions(rest)
      const id = words[0]
      if (!id) return { text: `Usage: /archivist ${verb === 'edit' ? 'edit <id> [--title "…"] [--content "…"] [--why "…"] [--paths "a/**,b/**"]' : 'deprecate <id> --reason "…"'}` }
      const now = new Date().toISOString()
      const r =
        verb === 'deprecate'
          ? await deprecateEntry(io, cfg, id, opts.reason ?? '', now)
          : await editEntry(io, cfg, id, editFromOptions(opts), now)
      await refreshStatus($, io)
      syncToMemoryLater($, root, 'fast')
      return { text: r.ok ? `${verb === 'edit' ? 'Updated' : 'Retired'} \`${r.entry.id}\`: ${r.entry.title}` : `Not changed: ${r.reason}` }
    }
    if (verb === 'memory') return { text: await memoryCommand($, io, cfg, rest[0] ?? 'status') }
    if (verb === 'stats') return { text: await statsText(io, (await loadState(io)).entries) }
    if (verb === 'health')
      return {
        text: await healthText(io, (await loadState(io)).entries, cfg, new Date(), {
          log: ((await $.store.get(logKey(root))) as string[] | undefined) ?? [],
          spentToday: ((await $.store.get(BUDGET_KEY + today())) as number | undefined) ?? 0,
        }),
      }
    if (verb === 'recall') return { text: recallText((await loadState(io)).entries, rest.join(' ')) }
    if (verb === 'apply' || verb === 'skip') {
      const chosen = pick(await listProposals(io), rest.join(','))
      if (!chosen.length) return { text: `Usage: /archivist ${verb} <n|1,3|all> — numbers from /archivist review.` }
      const now = new Date().toISOString()
      if (verb === 'skip') {
        await skipProposals(io, chosen, now)
        await refreshStatus($, io)
        return { text: `Skipped: ${chosen.map((p) => describeOp(p.op)).join('; ')}. The same ideas will not be proposed again.` }
      }
      const outcomes = await applyProposals(io, cfg, chosen, now)
      await refreshStatus($, io)
      syncToMemoryLater($, root, 'fast')
      return { text: ['Recorded:', ...outcomes.map((o) => `- ${o.title ?? ''}${o.id ? ` \`${o.id}\`` : ''}${o.reason ? ` (${o.reason})` : ''}`)].join('\n') }
    }
    if (verb === 'status') {
      const state = await loadState(io)
      const active = activeEntries(state.entries)
      const by = (t: string) => active.filter((x) => x.type === t).length
      const queued = (await listProposals(io)).length
      const open = seg ? `open task: ${seg.turns.length} turns, ${seg.tools.length} tool calls` : 'no open task'
      return {
        text: [
          `Archivist: ${active.length} active entries (${by('command')} commands, ${by('gotcha')} gotchas, ${by('decision')} decisions)`,
          `${queued} proposals waiting for review: /archivist review`,
          open,
          state.badLines.length ? `ledger: ${state.badLines.length} unreadable lines` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      }
    }
    const path = (await $.store.get(LAST_KEY + root)) as string | undefined
    const text = path ? await io.read(path) : undefined
    return { text: text ?? 'Archivist has no report yet: it writes one after a task that taught something.' }
  })
}
