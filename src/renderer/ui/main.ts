import {
  layoutCells,
  type AppConfig,
  type CollageLayout,
  type Interval,
  type IntervalUnit,
  type WallpaperConfig
} from '../../shared/types'
import { toDraft, buildSource, validateSource, type SourceDraft } from './source-draft'

// --- tiny hyperscript -------------------------------------------------------
type Child = Node | string | number | null | undefined
function h(
  tag: string,
  attrs: Record<string, unknown> = {},
  ...children: (Child | Child[])[]
): HTMLElement {
  const e = document.createElement(tag)
  // <select>.value only takes effect once its <option> children exist, so defer it.
  let deferredValue: string | undefined
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue
    if (k === 'class') e.className = String(v)
    else if (k.startsWith('on') && typeof v === 'function')
      e.addEventListener(k.slice(2).toLowerCase(), v as EventListener)
    else if (k === 'value') deferredValue = String(v)
    else if (k === 'checked') (e as HTMLInputElement).checked = Boolean(v)
    else e.setAttribute(k, String(v))
  }
  for (const c of children.flat()) {
    if (c == null) continue
    e.append(c instanceof Node ? c : document.createTextNode(String(c)))
  }
  if (deferredValue !== undefined) (e as HTMLInputElement).value = deferredValue
  return e
}

// --- state ------------------------------------------------------------------
let state: AppConfig
let hasApiKey = false
let peopleCache: Array<{ id: string; name: string }> | null = null
let currentTab = 'connection'

const app = document.getElementById('app') as HTMLElement
const statusDot = document.getElementById('statusDot') as HTMLElement
const errBar = document.getElementById('errBar') as HTMLElement

async function refreshState(): Promise<void> {
  const res = await window.api.getConfig()
  state = res.config
  hasApiKey = res.hasApiKey
  const status = await window.api.status()
  statusDot.classList.toggle('ok', status.connected && !status.error)
  statusDot.classList.toggle('err', Boolean(status.error))
  statusDot.title = status.error
    ? `Error: ${status.error}`
    : status.connected
      ? 'Connected'
      : 'Disconnected'
  if (status.error) {
    errBar.textContent = `⚠ ${status.error}`
    errBar.hidden = false
  } else {
    errBar.hidden = true
  }
  const pauseBtn = document.getElementById('pauseToggle') as HTMLButtonElement
  pauseBtn.textContent = status.paused ? 'Resume' : 'Pause'
}

async function ensurePeople(): Promise<Array<{ id: string; name: string }>> {
  if (!peopleCache) peopleCache = await window.api.people().catch(() => [])
  return peopleCache
}

// --- source editor ----------------------------------------------------------

function renderSourceEditor(draft: SourceDraft): HTMLElement {
  const body = h('div')
  const redraw = (): void => {
    body.replaceChildren()
    body.append(
      h('label', {}, 'Selection mode'),
      h(
        'select',
        {
          value: draft.kind,
          onchange: (ev: Event) => {
            const newKind = (ev.target as HTMLSelectElement).value as SourceDraft['kind']
            if (newKind !== draft.kind) {
              draft.kind = newKind
              draft.personIds = new Set()
            }
            redraw()
          }
        },
        h('option', { value: 'theme' }, 'Theme / topic (AI search)'),
        h('option', { value: 'person' }, 'Person'),
        h('option', { value: 'random' }, 'Random')
      )
    )
    if (draft.kind === 'theme') {
      body.append(
        h('label', {}, 'Theme query'),
        h('input', {
          type: 'text',
          value: draft.query,
          placeholder: 'e.g. beach sunsets, autumn forest',
          oninput: (ev: Event) => (draft.query = (ev.target as HTMLInputElement).value)
        }),
        peoplePicker(draft, 'Optionally limit to people (visual similarity)')
      )
    } else if (draft.kind === 'person') {
      body.append(peoplePicker(draft, 'People'))
    } else {
      body.append(
        h(
          'label',
          { style: 'display:flex;gap:6px;align-items:center;margin-top:10px' },
          h('input', {
            type: 'checkbox',
            checked: draft.favoritesOnly,
            style: 'width:auto',
            onchange: (ev: Event) => (draft.favoritesOnly = (ev.target as HTMLInputElement).checked)
          }),
          'Favorites only'
        )
      )
    }
  }
  redraw()
  return body
}

const PEOPLE_RENDER_CAP = 80 // avoid building thousands of checkboxes at once
function peoplePicker(draft: SourceDraft, title: string): HTMLElement {
  const wrap = h('div')
  wrap.append(h('label', {}, title))
  const search = h('input', { type: 'text', placeholder: 'Filter people…' }) as HTMLInputElement
  const list = h('div', { class: 'people' }, h('span', { class: 'hint' }, 'Loading people…'))
  wrap.append(search, list)

  void ensurePeople().then((people) => {
    if (people.length === 0) {
      list.replaceChildren(
        h('span', { class: 'hint' }, 'No people found (connect first / enable face recognition).')
      )
      return
    }
    const renderList = (): void => {
      const q = search.value.trim().toLowerCase()
      const selected = people.filter((p) => draft.personIds.has(p.id))
      const matches = q ? people.filter((p) => p.name.toLowerCase().includes(q)) : people
      // Always keep already-selected people visible, then fill up to the cap.
      const union = [...new Set([...selected, ...matches])]
      const shown = union.slice(0, PEOPLE_RENDER_CAP)
      list.replaceChildren(
        ...shown.map((p) =>
          h(
            'label',
            {},
            h('input', {
              type: 'checkbox',
              checked: draft.personIds.has(p.id),
              onchange: (ev: Event) => {
                if ((ev.target as HTMLInputElement).checked) draft.personIds.add(p.id)
                else draft.personIds.delete(p.id)
              }
            }),
            p.name
          )
        )
      )
      if (union.length > PEOPLE_RENDER_CAP) {
        list.append(
          h('span', { class: 'hint' }, `…and ${union.length - PEOPLE_RENDER_CAP} more — type to filter.`)
        )
      }
    }
    search.addEventListener('input', renderList)
    renderList()
  })
  return wrap
}

// --- interval editor --------------------------------------------------------
function intervalEditor(value: Interval, onChange: (i: Interval) => void): HTMLElement {
  const num = h('input', {
    type: 'number',
    min: '1',
    value: value.every,
    oninput: (ev: Event) =>
      onChange({ every: Math.max(1, +(ev.target as HTMLInputElement).value || 1), unit: value.unit })
  })
  const unit = h(
    'select',
    {
      value: value.unit,
      onchange: (ev: Event) =>
        onChange({ every: value.every, unit: (ev.target as HTMLSelectElement).value as IntervalUnit })
    },
    h('option', { value: 'minute' }, 'minute(s)'),
    h('option', { value: 'hour' }, 'hour(s)'),
    h('option', { value: 'day' }, 'day(s)')
  )
  return h('div', { class: 'interval' }, h('span', { class: 'hint', style: 'align-self:center' }, 'every'), num, unit)
}

// --- toast ------------------------------------------------------------------
const toastTimers = new WeakMap<HTMLElement, number>()
function toast(parent: HTMLElement, msg: string, ok = true): void {
  const prev = toastTimers.get(parent)
  if (prev) {
    clearTimeout(prev)
    toastTimers.delete(parent)
  }
  parent.querySelector('.toast')?.remove()
  const el = h('div', { class: `toast ${ok ? 'ok' : 'err'}` }, msg)
  parent.append(el)
  // Progress messages (trailing ellipsis, e.g. "Saving…") stay until their result
  // replaces them; final messages auto-dismiss so repeated actions give feedback.
  if (!msg.endsWith('…')) {
    const t = window.setTimeout(() => {
      el.remove()
      toastTimers.delete(parent)
    }, ok ? 2500 : 6000)
    toastTimers.set(parent, t)
  }
}

// ===========================================================================
// Tabs
// ===========================================================================
function connectionTab(): HTMLElement {
  const root = h('div')
  const card = h('div', { class: 'card' })
  const urlInput = h('input', {
    type: 'url',
    value: state.server.baseUrl,
    placeholder: 'http://your-immich:2283'
  }) as HTMLInputElement
  const keyInput = h('input', {
    type: 'password',
    placeholder: hasApiKey ? '•••••••• (saved — leave blank to keep)' : 'Immich API key'
  }) as HTMLInputElement

  card.append(
    h('h3', {}, 'Immich connection'),
    h('label', {}, 'Server URL'),
    urlInput,
    h('label', {}, 'API key'),
    keyInput,
    h(
      'div',
      { class: 'row', style: 'margin-top:12px' },
      h(
        'button',
        {
          class: 'secondary',
          onclick: async () => {
            toast(card, 'Testing…')
            const r = await window.api.testConnection(urlInput.value, keyInput.value)
            if (r.ok) toast(card, `Connected as ${r.user} · ${r.assetCount ?? '?'} assets`, true)
            else toast(card, `Failed: ${r.error}`, false)
          }
        },
        'Test connection'
      ),
      h(
        'button',
        {
          onclick: async () => {
            await window.api.setServer(urlInput.value, keyInput.value)
            peopleCache = null
            await refreshState()
            toast(card, 'Saved.', true)
          }
        },
        'Save'
      )
    )
  )
  root.append(card)

  const startupCard = h('div', { class: 'card' })
  startupCard.append(
    h('h3', {}, 'Startup'),
    h(
      'label',
      { style: 'display:flex;gap:6px;align-items:center;margin-top:0' },
      h('input', {
        type: 'checkbox',
        checked: state.launchAtLogin,
        style: 'width:auto',
        onchange: async (ev: Event) => {
          const enabled = (ev.target as HTMLInputElement).checked
          await window.api.setLaunchAtLogin(enabled)
          state.launchAtLogin = enabled
        }
      }),
      'Launch at login (starts hidden in the menu bar)'
    )
  )
  root.append(startupCard)
  return root
}

function wallpaperTab(): HTMLElement {
  const root = h('div')
  const active = state.active
  const sourceDraft = toDraft(active.source)
  let mode: WallpaperConfig['mode'] = active.mode
  let singleInterval: Interval = active.mode === 'single' ? active.interval : { every: 30, unit: 'minute' }
  let layout: Exclude<CollageLayout, 'custom'> =
    active.mode === 'collage' && active.layout !== 'custom' ? active.layout : 'grid-2x2'
  let collageInterval: Interval =
    active.mode === 'collage' ? active.interval : { every: 30, unit: 'minute' }
  let gap = active.mode === 'collage' ? active.gap : 8
  let background = active.mode === 'collage' ? active.background : '#000000'

  const collageHost = h('div')
  function renderCollage(): void {
    collageHost.replaceChildren()
    if (mode !== 'collage') return
    collageHost.append(
      h('label', {}, 'Layout'),
      h(
        'select',
        {
          value: layout,
          onchange: (ev: Event) => {
            layout = (ev.target as HTMLSelectElement).value as typeof layout
            renderCollage()
          }
        },
        h('option', { value: 'grid-2x2' }, '2 × 2 (4 tiles)'),
        h('option', { value: 'grid-3x2' }, '3 × 2 (6 tiles)'),
        h('option', { value: 'grid-1x3' }, '1 × 3 (3 columns)')
      ),
      h('span', { class: 'hint' }, 'Tiles are sized to each image’s shape; all tiles refresh together.'),
      h('label', {}, 'All tiles rotate'),
      intervalEditor(collageInterval, (i) => (collageInterval = i)),
      h('div', { class: 'row', style: 'margin-top:10px' },
        h('div', {}, h('label', { style: 'margin-top:0' }, 'Gap (px)'),
          h('input', { type: 'number', min: '0', value: gap,
            oninput: (ev: Event) => (gap = Math.max(0, +(ev.target as HTMLInputElement).value || 0)) })),
        h('div', {}, h('label', { style: 'margin-top:0' }, 'Background'),
          h('input', { type: 'text', value: background,
            oninput: (ev: Event) => (background = (ev.target as HTMLInputElement).value) }))
      )
    )
  }

  // mode toggle
  const modeSeg = h('div', { class: 'segmented' })
  function renderModeSeg(): void {
    modeSeg.replaceChildren(
      h('button', { class: mode === 'single' ? 'active' : '', onclick: () => { mode = 'single'; renderModeSeg(); renderCollage() } }, 'Single image'),
      h('button', { class: mode === 'collage' ? 'active' : '', onclick: () => { mode = 'collage'; renderModeSeg(); renderCollage() } }, 'Collage')
    )
  }
  renderModeSeg()

  const srcCard = h('div', { class: 'card' }, h('h3', {}, 'Image source'), renderSourceEditor(sourceDraft))

  const previewBox = h('div')
  const sourceActions = h('div', { class: 'row', style: 'margin-top:10px' },
    h('button', { class: 'secondary', onclick: async () => {
      const err = validateSource(sourceDraft)
      if (err) { toast(srcCard, err, false); return }
      toast(srcCard, 'Searching…')
      const r = await window.api.preview(buildSource(sourceDraft))
      srcCard.querySelector('.toast')?.remove()
      previewBox.replaceChildren(
        h('div', { class: 'hint' }, `${r.count} matching images`),
        h('div', { class: 'thumbs' }, ...r.samples.map((s) => h('img', { src: s })))
      )
    } }, 'Preview')
  )
  srcCard.append(sourceActions, previewBox)

  const modeCard = h('div', { class: 'card' },
    h('h3', {}, 'Mode'), modeSeg,
    h('div', { style: 'margin-top:12px' },
      h('label', { style: 'margin-top:0' }, 'Single image rotates'),
      mode === 'single'
        ? intervalEditor(singleInterval, (i) => (singleInterval = i))
        : h('span', { class: 'hint' }, 'Rotation timing is configured below.')
    )
  )
  // re-render single interval block when toggling — simplest: keep both, but the
  // single interval editor only reflects state at load; rebuild on toggle:
  function rebuildModeCard(): void {
    const block = modeCard.lastChild as HTMLElement
    block.replaceChildren(
      h('label', { style: 'margin-top:0' }, mode === 'single' ? 'Single image rotates' : 'Tiles'),
      mode === 'single'
        ? intervalEditor(singleInterval, (i) => (singleInterval = i))
        : h('span', { class: 'hint' }, 'Rotation timing is configured below.')
    )
  }
  modeSeg.addEventListener('click', () => setTimeout(rebuildModeCard, 0))

  const collageCard = h('div', { class: 'card' }, h('h3', {}, 'Collage layout'), collageHost)
  renderCollage()

  const saveCard = h('div', { class: 'card' })
  saveCard.append(
    h('button', { onclick: async () => {
      const err = validateSource(sourceDraft)
      if (err) { toast(saveCard, err, false); return }
      const source = buildSource(sourceDraft)
      let cfg: WallpaperConfig
      if (mode === 'single') {
        cfg = { mode: 'single', source, interval: singleInterval }
      } else {
        const rects = layoutCells(layout)
        cfg = {
          mode: 'collage', source, layout, gap, background,
          interval: collageInterval,
          cells: rects.map((rect) => ({ rect }))
        }
      }
      await window.api.setActive(cfg)
      await refreshState()
      toast(saveCard, 'Saved & applied.', true)
    } }, 'Save & apply')
  )

  root.append(modeCard, srcCard, collageCard, saveCard)
  // Hide collage card in single mode by toggling display.
  const syncCardVisibility = (): void => { collageCard.style.display = mode === 'collage' ? '' : 'none' }
  syncCardVisibility()
  modeSeg.addEventListener('click', () => setTimeout(syncCardVisibility, 0))
  return root
}

function presetsTab(): HTMLElement {
  const root = h('div')
  const card = h('div', { class: 'card' }, h('h3', {}, 'Presets'))
  const nameInput = h('input', { type: 'text', placeholder: 'Preset name' }) as HTMLInputElement
  card.append(
    h('label', {}, 'Save current wallpaper config as'),
    h('div', { class: 'row' }, nameInput,
      h('button', { onclick: async () => {
        if (!nameInput.value.trim()) { toast(card, 'Enter a name.', false); return }
        await window.api.savePreset(nameInput.value.trim())
        await refreshState(); render(); toast(card, 'Saved.', true)
      } }, 'Save preset'))
  )
  const list = h('div', { style: 'margin-top:12px' })
  const names = Object.keys(state.presets)
  if (names.length === 0) list.append(h('span', { class: 'hint' }, 'No presets yet.'))
  for (const name of names) {
    list.append(
      h('div', { class: 'row', style: 'margin-bottom:6px' },
        h('span', { style: 'flex:2;align-self:center' }, name),
        h('button', { class: 'secondary', onclick: async () => { await window.api.loadPreset(name); await refreshState(); toast(card, `Applied "${name}".`, true) } }, 'Apply'),
        h('button', { class: 'secondary', onclick: async () => { await window.api.deletePreset(name); await refreshState(); render() } }, 'Delete')
      )
    )
  }
  card.append(list)
  root.append(card)
  return root
}

// ===========================================================================
function render(): void {
  document.querySelectorAll('.tabs button').forEach((b) =>
    b.classList.toggle('active', (b as HTMLElement).dataset.tab === currentTab)
  )
  const view =
    currentTab === 'connection' ? connectionTab() : currentTab === 'wallpaper' ? wallpaperTab() : presetsTab()
  app.replaceChildren(view)
}

function wireChrome(): void {
  document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((b) =>
    b.addEventListener('click', () => {
      currentTab = b.dataset.tab!
      render()
    })
  )
  document.getElementById('applyNow')!.addEventListener('click', () => void window.api.applyNow())
  document.getElementById('pauseToggle')!.addEventListener('click', async () => {
    const status = await window.api.status()
    await window.api.setPaused(!status.paused)
    await refreshState()
  })
}

async function boot(): Promise<void> {
  await refreshState()
  wireChrome()
  render()
  // Live updates from the main process (e.g. a rotation failed in the background).
  window.api.onStatusChanged(() => void refreshState())
}
void boot()
