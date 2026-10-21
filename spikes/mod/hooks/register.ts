import type { Register } from 'claude-code'

// Spike for archivist: records what the mods API gives us, as JSONL, to LOG.
// Point it at a scratch file before loading the spike.
const LOG = '/tmp/archivist-spike/mod-spike.jsonl'

const shape = (v: unknown, depth = 0): unknown => {
  if (v === null || typeof v !== 'object') return typeof v
  if (Array.isArray(v)) return depth > 2 ? `array(${v.length})` : [`array(${v.length})`, v.length ? shape(v[0], depth + 1) : null]
  if (depth > 2) return 'object'
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x, depth + 1)]))
}

async function append($: any, rec: Record<string, unknown>) {
  let prev = ''
  try {
    if (await $.fs.exists(LOG)) prev = await $.fs.read(LOG)
  } catch {}
  try {
    await $.fs.write(LOG, prev + JSON.stringify({ ts: await $.clock.now(), ...rec }) + '\n')
  } catch (err) {
    await $.store.set('spike-log-error', String(err))
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await append($, { ev: 'session.start', e: shape(e) })
    $.ui.status('archivist-spike: loaded')
    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    await append($, { ev: 'classic.SessionStart', keys: Object.keys(e ?? {}) })
    return next(e)
  })
  on('classic.UserPromptSubmit', async ($, e, next) => {
    await append($, { ev: 'classic.UserPromptSubmit', keys: Object.keys(e ?? {}) })
    return next(e)
  })
  on('classic.Stop', async ($, e, next) => {
    await append($, { ev: 'classic.Stop', keys: Object.keys(e ?? {}) })
    return next(e)
  })
  on('classic.InstructionsLoaded', async ($, e, next) => {
    const { session_id, transcript_path, cwd, ...rest } = e as any
    await append($, { ev: 'classic.InstructionsLoaded', payload: rest })
    return next(e)
  }).catch(($, e, next) => next(e))
  on('classic.PostToolUse', async ($, e, next) => {
    await append($, { ev: 'classic.PostToolUse', keys: Object.keys(e ?? {}), tool: (e as any).tool_name })
    return next(e)
  })

  let turns = 0
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined) return r
    turns += 1
    const n = turns
    await append($, { ev: 'turn.complete', n, e: shape(e), answerLen: e.answer.length, durationMs: e.durationMs, usage: e.usage, result: shape(r) })

    // Background work after the turn: must not hold the turn's dispatch.
    $.clock.after(1500, async () => {
      try {
        const usage = await $.session.usage()
        const msgs = await $.session.messages()
        await append($, {
          ev: 'bg.session', n,
          usage: shape(usage), cost: (usage as any).cost, context: usage.context,
          messages: { count: msgs.length, first: shape(msgs[0]), lastToolUse: shape(msgs.findLast(m => m.toolUses.length)?.toolUses[0]) },
        })
        const t0 = await $.clock.now()
        const c = await $.model.complete({ model: 'haiku', prompt: 'Reply with exactly: PONG', maxTokens: 16, timeoutMs: 60000 })
        await append($, { ev: 'bg.model.complete', n, ms: (await $.clock.now()) - t0, c })
        if (!(await $.store.get('fork-done'))) {
          await $.store.set('fork-done', true)
          const t1 = await $.clock.now()
          const f = await $.model.fork({ prompt: 'In one short line: what was the last task in this conversation about? Answer only the line.' })
          await append($, { ev: 'bg.model.fork', n, ms: (await $.clock.now()) - t1, f })
        }
        $.ui.toast(`archivist-spike: bg done for turn ${n}`)
        $.ui.status(`archivist-spike: turn ${n} analysed`)
        const sent = await $.ui.notify(`archivist-spike: turn ${n} analysed`)
        await append($, { ev: 'bg.notify', n, sent })
        // Analog of asyncRewake: wake the idle session once with an informational report.
        if (!(await $.store.get('submit-done'))) {
          await $.store.set('submit-done', true)
          const s = await $.prompt.submit({
            text: 'archivist-spike background report (informational, nothing to do): turn analysed. Reply with one short line acknowledging it.',
          })
          await append($, { ev: 'bg.prompt.submit', n, s: shape(s) })
        }
      } catch (err) {
        await append($, { ev: 'bg.error', n, err: String(err) })
      }
    })

    return { ...r, text: `📚 archivist-spike: line under answer (turn ${n}, ${Math.round(e.durationMs / 1000)} s)` }
  }).catch(async ($, e, next) => {
    await append($, { ev: 'turn.complete.catch', err: next.error })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await append($, { ev: 'session.end', reason: (e as any).reason })
    return next(e)
  })
}
