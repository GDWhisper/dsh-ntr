/**
 * The composer's thought-level chip and its picker.
 *
 * One state cannot be answered from cache: a model the agent has never been
 * observed on has no level list anywhere (`reasoningByModel` has no record).
 * The catalog reports that honestly as "unknown", and this card is where the
 * user can ask the agent — the fetch button is an explicit gesture, so it may
 * spawn the agent's probe process (see AGENTS/state.md §4). Opening the picker
 * never probes; only the fetch row does, and a failure stays inside this card.
 *
 * Level lists are per model (opencode publishes `thought_level` only for models
 * with variants), so the fetch asks about ONE model: the host switches a
 * throwaway session through the agent's own `session/set_config_option` and
 * records the answer under that model.
 */
import type { AcpChatInjected, AcpMenuItem, AcpMenuSection } from './acp-ui.tsx'

/**
 * The fetch row's id. Safe as a sentinel because the card renders it ONLY while
 * the model has no levels: no real level row exists beside it to collide with.
 */
export const FETCH_THOUGHT_ITEM = '__fetch-thought__'

/** The route facts the chip and the picker read (a subset of `RouteInfo`). */
export interface ThoughtRoute {
  efforts: readonly { id: string; name: string; description?: string }[]
  effectiveEffort?: string
  effortLabel?: string
  /** The model whose levels were never observed (`describeRoute`'s own field). */
  thoughtUnknown?: string
}

/** The fetch state of the unknown card: never probed, in flight, or failed. */
export interface ThoughtProbe {
  probing?: boolean
  error?: string
}

/** The chip's words: the level in force, or that this model's levels are unknown. */
export function thoughtChip(route: ThoughtRoute, acp: AcpChatInjected['acp']): { label: string; title: string } {
  if (route.thoughtUnknown !== undefined) {
    return {
      label: `${acp.label('思考', 'think')} · ${acp.label('默认', 'default')}`,
      title: acp.label(
        '该模型还没连接过，先跟随默认思考等级，点开可获取它的等级',
        'This model has not been connected yet — it uses the default thought level; open to fetch its levels',
      ),
    }
  }
  return {
    label: `${acp.label('思考', 'think')} · ${route.effortLabel ?? acp.label('默认', 'default')}`,
    title: acp.label('思考等级（agent 的 thought_level）', "Thought level (the agent's thought_level)"),
  }
}

/** The picker section: the model's levels, or the unknown state and its button. */
export function thoughtSection(
  route: ThoughtRoute,
  acp: AcpChatInjected['acp'],
  probe?: ThoughtProbe,
): AcpMenuSection {
  // The model's own default is selectable in BOTH states — "unknown levels" is
  // not "no default". The id keeps its historical sentinel name on purpose: it
  // is what the pick handler clears with, and no user ever reads it. The LABEL
  // is the user-visible claim: this axis is the agent's own `thought_level`,
  // with no DSH provider anywhere on it (`listModels('acp')` answers an empty
  // catalog). Clearing the pick leaves the agent's own default in force.
  const defaultRow: AcpMenuItem = {
    id: 'provider-default',
    label: acp.label('跟随 agent 默认', 'Agent default'),
    active: route.effectiveEffort === undefined,
  }
  if (route.thoughtUnknown !== undefined) {
    const probing = probe?.probing === true
    const failed = probe?.error !== undefined
    return {
      id: 'thought',
      // One sentence (§33): the mechanism lives in the module header.
      note: acp.label(
        '该模型还没连接过，先跟随它的默认思考等级。',
        'This model has not been connected yet — its default thought level applies for now.',
      ),
      // Default first, then the fetch: an unknown list does not take the
      // model's own default away. The pick handler recognizes the sentinel and
      // sends no effort at all, so this row never probes.
      items: [defaultRow, {
        id: FETCH_THOUGHT_ITEM,
        label: probing
          ? acp.label('正在获取…', 'Fetching…')
          : failed ? acp.label('重试获取', 'Fetch again') : acp.label('获取模型思考等级列表', "Get the model's thought levels"),
        detail: failed && !probing
          ? acp.label('上次获取失败，点此重试', 'last fetch failed — retry')
          : acp.label('连上 agent 读一次它的配置', 'connect to the agent and read its config once'),
        disabled: probing,
      }],
    }
  }
  const items: AcpMenuItem[] = [defaultRow]
  for (const level of route.efforts) {
    items.push({
      id: level.id,
      label: level.name,
      ...level.description === undefined ? {} : { detail: level.description },
      active: level.id === route.effectiveEffort,
    })
  }
  return {
    id: 'thought',
    note: acp.label(
      '由 agent 的 thought_level 配置项驱动，下一次请求生效。',
      "Driven by the agent's own thought_level option; applies to the next request.",
    ),
    items,
  }
}
