// What the Ctrl+P panel reads about the running CC session: cost and name
// from the transcript JSONL, model / effort / permission mode off the
// screen, Bash output blocks for the hide toggle. Pure functions.

import { closeSync, openSync, readSync, statSync } from 'node:fs'

// $ per million tokens. From the Claude API reference bundled with Claude
// Code (model table cached 2026-10-06). cacheRead: models whose cache reads
// aren't the usual 0.1x of input. Cache writes: 1.25x input (5-minute TTL),
// 2x (1-hour). Haiku 5.5 is billed higher above 100K-token prompts; the
// base rate is used here.
const prices = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, fast: { input: 8, output: 40 } },
  'claude-opus-5': { input: 5, output: 25, fast: { input: 10, output: 50 } },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-haiku-4-5': { input: 1, output: 5 },
}

/** "a/anthropic/claude-opus-5.5[1m]" → "claude-opus-5-5" (gateway prefixes, dots, context tags). */
export function normalizeModel(m) {
  return String(m ?? '')
    .split('/')
    .pop()
    .replace(/\[.*\]$/, '')
    .replace(/\./g, '-')
    .replace(/-\d{8}$/, '')
}

/** Cost in $ of one assistant message's usage on `model`, or null if unpriced. */
export function usageCost(model, u) {
  const p = prices[normalizeModel(model)]
  if (!p || !u) return null
  const rate = u.speed === 'fast' && p.fast ? { ...p, ...p.fast } : p
  const w5 = u.cache_creation?.ephemeral_5m_input_tokens ?? u.cache_creation_input_tokens ?? 0
  const w1 = u.cache_creation?.ephemeral_1h_input_tokens ?? 0
  const read = p.cacheRead ?? rate.input * 0.1
  return (
    ((u.input_tokens ?? 0) * rate.input +
      (u.output_tokens ?? 0) * rate.output +
      w5 * rate.input * 1.25 +
      w1 * rate.input * 2 +
      (u.cache_read_input_tokens ?? 0) * read) /
    1e6
  )
}

/** Entries of a JSONL text; lines that don't parse are skipped. */
export function parseEntries(text) {
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {}
  }
  return out
}

/**
 * An entry's cost the first time its assistant message shows up, else
 * undefined. A message is logged once per content block with the same
 * usage, so `seen` (message ids) makes it count once. null: unpriced model.
 */
export function messageCost(d, seen) {
  const m = d.message
  if (d.type !== 'assistant' || !m?.usage) return undefined
  const id = m.id ?? d.uuid
  if (seen.has(id)) return undefined
  seen.add(id)
  return usageCost(m.model, m.usage)
}

/** Summarize a transcript (JSONL text): total cost, session name, last model. */
export function summarizeTranscript(text) {
  const seen = new Set()
  let cost = 0
  let unpriced = 0
  let title = null
  let aiTitle = null
  let model = null
  for (const d of parseEntries(text)) {
    if (d.type === 'custom-title' && d.customTitle) title = d.customTitle
    if (d.type === 'ai-title' && d.aiTitle) aiTitle = d.aiTitle
    if (d.type === 'assistant' && d.message?.usage && d.message.model) model = d.message.model
    const c = messageCost(d, seen)
    if (c === null) unpriced++
    else if (c !== undefined) cost += c
  }
  return { cost, unpriced, name: title ?? aiTitle, model }
}

/**
 * Follow a growing JSONL file: each call returns the entries appended since
 * the last one (a partial last line waits for its newline). Starts over
 * when the path changes or the file shrinks.
 */
export function tailEntries(read = readFrom) {
  let path = null
  let offset = 0
  let partial = Buffer.alloc(0)
  return p => {
    if (p !== path) [path, offset, partial] = [p, 0, Buffer.alloc(0)]
    if (!p) return []
    const r = read(p, offset)
    if (!r) return []
    if (r.from < offset) partial = Buffer.alloc(0)
    offset = r.from + r.buf.length
    const buf = Buffer.concat([partial, r.buf])
    const nl = buf.lastIndexOf(10)
    partial = buf.subarray(nl + 1)
    return nl < 0 ? [] : parseEntries(buf.subarray(0, nl + 1).toString('utf8'))
  }
}

/** Bytes of `path` from `offset` on (from 0 if it shrank): { buf, from }. */
function readFrom(path, offset) {
  try {
    const size = statSync(path).size
    const from = size < offset ? 0 : offset
    const buf = Buffer.alloc(size - from)
    if (buf.length) {
      const fd = openSync(path, 'r')
      try {
        readSync(fd, buf, 0, buf.length, from)
      } finally {
        closeSync(fd)
      }
    }
    return { buf, from }
  } catch {
    return null
  }
}

// ---- reading CC's status line ----

export const efforts = ['low', 'medium', 'high', 'xhigh', 'max']
export const modes = ['plan', 'norm', 'auto']
export const models = ['haiku', 'sonnet', 'opus', 'fable']

/** "◐ medium · /effort" → "medium". */
export function effortOf(text) {
  return text.match(/\b(low|medium|high|xhigh|max)\s*·\s*\/effort/)?.[1] ?? null
}

/** Permission mode from the status line: plan / norm (manual) / auto / edits. */
export function modeOf(text) {
  if (/plan mode on/.test(text)) return 'plan'
  if (/auto mode on/.test(text)) return 'auto'
  if (/accept edits on/.test(text)) return 'edits'
  if (/manual mode on/.test(text)) return 'norm'
  return null
}

/** Which of `models` a model id / display name is. */
export function modelFamily(m) {
  const s = String(m ?? '').toLowerCase()
  return models.find(f => s.includes(f)) ?? null
}

/**
 * Rows of Bash tool output: after a "● Bash(…)" header, the "⎿" row and
 * the indented continuation rows below it.
 */
export function bashOutputRows(rows) {
  const out = new Set()
  let inBlock = false
  rows.forEach((r, i) => {
    if (/^[●⏺] Bash\(/.test(r)) {
      inBlock = true
      return
    }
    if (inBlock && (/^\s{2}⎿/.test(r) || /^\s{5}\S/.test(r))) out.add(i)
    else inBlock = false
  })
  return out
}
