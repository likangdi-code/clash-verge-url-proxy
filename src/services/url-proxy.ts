import { nanoid } from 'nanoid'
import {
  getProxies,
  selectNodeForGroup,
  delayProxyByName,
} from 'tauri-plugin-mihomo-api'
import yaml from 'js-yaml'

import delayManager from './delay'
import {
  getProfiles,
  readProfileFile,
  saveProfileFile,
  enhanceProfiles,
} from './cmds'
import { debugLog } from '@/utils/debug'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface UrlProxyEntry {
  id: string
  url: string
  /** 从 URL 中提取的域名/主机（用于显示和路由） */
  host: string
  /** 用户在代理组列表中手动选择的节点（空=未选） */
  selectedProxy: string | null
  /** 最后一次自动测速选中的节点 */
  autoSelectedProxy: string | null
  /** 是否开启自动选择：开启后测速完成自动选最低延迟节点（每栏独立持久化） */
  autoSelect?: boolean
  createdAt: number
}

// ─── Storage ─────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'url-proxy-entries'

function loadEntries(): UrlProxyEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    return JSON.parse(raw) as UrlProxyEntry[]
  } catch {
    return []
  }
}

function saveEntries(entries: UrlProxyEntry[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// ─── Public API ──────────────────────────────────────────────────────────────

export function getAllEntries(): UrlProxyEntry[] {
  return loadEntries()
}

export function getEntry(id: string): UrlProxyEntry | undefined {
  return loadEntries().find((e) => e.id === id)
}

/** 从当前 profile 增强文件恢复 URL-Proxy 条目（localStorage 缺失时补全）
 *
 * 背景：网址代理条目存 localStorage，但增强文件才是 mihomo 真实生效的
 * 事实来源。当 localStorage 丢失 / 跨环境（dev↔release 的 WebView 数据不
 * 共享）时，「网址代理」菜单会显示为空，而 mihomo 里的 URL-Proxy 组与
 * 规则仍然存在（「代理」菜单可见）。此函数读取增强文件，把"有组又有规则"
 * 的 URL-Proxy 反推为条目合并回 localStorage，实现跨环境持久化恢复。
 *
 * 幂等：localStorage 已有的条目（含 selectedProxy/autoSelect 元数据）保留。
 */
export async function restoreEntriesFromEnhance(): Promise<void> {
  const uids = await getCurrentEnhancementUids()
  if (!uids?.groups || !uids?.rules) return

  try {
    const groupsRaw = (await readProfileFile(uids.groups)) as string
    const groupsObj = (yaml.load(groupsRaw) as any) || {}
    const groupNames = new Set(
      (Array.isArray(groupsObj.append) ? groupsObj.append : [])
        .filter((g: any) => isUrlProxyName(g?.name ?? ''))
        .map((g: any) => g.name),
    )
    if (groupNames.size === 0) return

    const rulesRaw = (await readProfileFile(uids.rules)) as string
    const rulesObj = (yaml.load(rulesRaw) as any) || {}
    const append = Array.isArray(rulesObj.append) ? rulesObj.append : []

    const existing = loadEntries()
    const existingById = new Map(existing.map((e) => [e.id, e]))

    const restored: UrlProxyEntry[] = []
    for (const rule of append) {
      if (typeof rule !== 'string' || !rule.includes('URL-Proxy-')) continue
      const parts = rule.split(',')
      if (parts.length !== 3) continue
      const [, host, group] = parts
      if (!groupNames.has(group)) continue // 只恢复"有组"的规则
      const id = group.slice('URL-Proxy-'.length)
      if (existingById.has(id)) continue // 已有条目保留原元数据
      restored.push({
        id,
        host,
        url: host.endsWith('.onion') ? `http://${host}` : `https://${host}`,
        selectedProxy: null,
        autoSelectedProxy: null,
        createdAt: 0,
      })
    }

    if (restored.length === 0) return
    saveEntries([...existing, ...restored])
  } catch (e) {
    console.error('[URLProxy] 从增强文件恢复条目失败:', e)
  }
}

export function addEntry(url: string): UrlProxyEntry | null {
  // 校验 + 规范化 URL：保证 entry.url 一定是带 scheme 的完整 URL
  // - 普通域名默认 https
  // - .onion 必须用 http（tor 默认无 TLS）
  let host: string
  let normalizedUrl: string
  try {
    const trimmed = url.trim()
    const withScheme = trimmed.startsWith('http')
      ? trimmed
      : trimmed.endsWith('.onion')
        ? `http://${trimmed}`
        : `https://${trimmed}`
    const u = new URL(withScheme)
    host = u.hostname
    normalizedUrl = withScheme
  } catch {
    return null
  }

  const entries = loadEntries()
  // 去重：同一域名不重复添加
  if (entries.some((e) => e.host === host)) return null

  const entry: UrlProxyEntry = {
    id: nanoid(8),
    url: normalizedUrl,
    host,
    selectedProxy: null,
    autoSelectedProxy: null,
    createdAt: Date.now(),
  }
  // 最新新建的网址栏显示在最上面（prepend 而非 append）
  saveEntries([entry, ...entries])
  return entry
}

export function removeEntry(id: string): void {
  const entries = loadEntries().filter((e) => e.id !== id)
  saveEntries(entries)
}

export function updateEntry(id: string, patch: Partial<UrlProxyEntry>): UrlProxyEntry | null {
  const entries = loadEntries()
  const idx = entries.findIndex((e) => e.id === id)
  if (idx < 0) return null
  entries[idx] = { ...entries[idx], ...patch }
  saveEntries(entries)
  return entries[idx]
}

// ─── Mihomo API (复用 tauri-plugin-mihomo-api，与"代理"菜单同源) ────────────
//
// 不再自写 fetch 直调 mihomo REST；改用项目统一的 tauri-plugin-mihomo-api，
// 走 Tauri 后端，错误处理与"代理"菜单完全一致。

/** 生成 mihomo 代理组名称 */
export function getGroupName(entry: UrlProxyEntry): string {
  return `URL-Proxy-${entry.id}`
}

/** 是否为「网址代理」生成的代理组（用于隔离两个菜单） */
export const isUrlProxyName = (name: string) => name.startsWith('URL-Proxy-')

/** 获取所有可用代理名称列表
 *
 * 排除 GLOBAL/DIRECT/REJECT 与 URL-Proxy 组自身：
 * 避免 URL-Proxy 组互相引用导致增强文件无限膨胀（mihomo 校验变慢/失败）。
 *
 * 自愈：mihomo 在 reload 窗口 / 刚启动时 `getProxies` 可能瞬时不响应或返回空，
 * 此时直接失败会导致「新建网址代理失败」的偶发问题。故对失败/空做有限重试。
 */
export async function fetchAllProxyNames(
  attempts: number = 3,
): Promise<string[]> {
  for (let i = 0; i < attempts; i++) {
    try {
      const data = await getProxies()
      const names = data?.proxies
        ? Object.keys(data.proxies).filter(
            (name) =>
              name !== 'GLOBAL' &&
              name !== 'DIRECT' &&
              name !== 'REJECT' &&
              !isUrlProxyName(name),
          )
        : []
      if (names.length > 0) return names
      if (i < attempts - 1) {
        console.warn(`[URLProxy] 代理列表为空，${300}ms 后重试`)
        await sleep(300)
      }
    } catch (e) {
      console.error(`[URLProxy] 获取代理列表失败(第${i + 1}/${attempts}次):`, e)
      if (i < attempts - 1) await sleep(300)
    }
  }
  return []
}

/** 取当前 current profile 的 groups/rules 增强条目 uid
 *
 * 增强文件（groups/rules）是独立的 profile 条目，`option.groups` /
 * `option.rules` 存的是对应条目 uid；`readProfileFile(uid)` 即可读写其 YAML。
 * 若当前 profile 未启用增强（uid 缺失）则返回 null。
 */
async function getCurrentEnhancementUids(): Promise<{
  groups?: string
  rules?: string
} | null> {
  try {
    const profiles = (await getProfiles()) as any
    const currentUid = profiles?.current
    if (!currentUid) return null
    const item = (profiles?.items ?? []).find(
      (it: any) => it?.uid === currentUid,
    )
    if (!item) return null
    return {
      groups: item?.option?.groups,
      rules: item?.option?.rules,
    }
  } catch (e) {
    console.error('[URLProxy] 读取当前订阅增强信息失败:', e)
    return null
  }
}

/** 从增强文件提取已有 URL-Proxy 组的历史节点列表（兜底用）
 *
 * 当 mihomo `getProxies` 瞬时不响应时，用上次成功写入的节点列表重建组，
 * 避免「新建网址代理失败」的偶发问题。语义与 `fetchAllProxyNames` 对齐：
 * 排除 GLOBAL/DIRECT/REJECT 与 URL-Proxy 组自身。
 */
async function loadProxyNamesFromEnhance(): Promise<string[]> {
  try {
    const uids = await getCurrentEnhancementUids()
    if (!uids?.groups) return []
    const raw = (await readProfileFile(uids.groups)) as string
    const obj = (yaml.load(raw) as any) || {}
    const append = Array.isArray(obj.append) ? obj.append : []
    const names = new Set<string>()
    for (const g of append) {
      if (!isUrlProxyName(g?.name ?? '') || !Array.isArray(g.proxies)) continue
      for (const n of g.proxies) {
        if (
          typeof n === 'string' &&
          n !== 'GLOBAL' &&
          n !== 'DIRECT' &&
          n !== 'REJECT' &&
          !isUrlProxyName(n)
        ) {
          names.add(n)
        }
      }
    }
    return [...names]
  } catch (e) {
    console.error('[URLProxy] 从增强文件提取节点失败:', e)
    return []
  }
}

/** 同步 Groups 增强文件：以 localStorage 的 entries 为唯一来源重建 URL-Proxy 组
 *
 * - 有可用节点时：重建全部 URL-Proxy 组（代理列表保持干净、不互相引用）
 * - 无可用节点时：仅移除不再需要的孤儿组，保留已有组结构
 * - 保存失败（校验不过）时 Rust 侧会回滚文件并返回 false
 *
 * 防误删：URL-Proxy 组只有「被 rules 引用」或「仍存在于 entries」时才保留。
 * 原因：若 localStorage 与增强文件不同步（跨环境、restore 不完整），
 * 以 entries 为唯一来源全量重建会误删 mihomo 里真实生效的组 → 网址消失。
 * 规则引用（rules）才是真实生效来源，故保留「仍有规则引用」的组。
 */
async function syncGroupsFile(
  groupsUid: string,
  rulesUid: string,
  entries: UrlProxyEntry[],
  allProxies: string[],
): Promise<boolean> {
  try {
    const raw = (await readProfileFile(groupsUid)) as string
    const obj = (yaml.load(raw) as any) || {}
    const existing = Array.isArray(obj.append) ? obj.append : []
    const entryNames = new Set(entries.map(getGroupName))

    // 读 rules 增强，找出仍被引用的 URL-Proxy 组（防不同步误删的关键依据）
    const referencedGroups = new Set<string>()
    try {
      const rulesRaw = (await readProfileFile(rulesUid)) as string
      const rulesObj = (yaml.load(rulesRaw) as any) || {}
      const rulesAppend = Array.isArray(rulesObj.append)
        ? rulesObj.append
        : []
      for (const rule of rulesAppend) {
        if (typeof rule !== 'string' || !rule.includes('URL-Proxy-')) continue
        const parts = rule.split(',')
        if (parts.length === 3) referencedGroups.add(parts[2])
      }
    } catch (e) {
      console.error('[URLProxy] 读取规则增强失败(孤儿组判断降级):', e)
    }

    let append: any[]
    if (allProxies.length > 0) {
      const kept = existing.filter((g: any) => !isUrlProxyName(g?.name ?? ''))
      // 保留既有的 URL-Proxy 组：仍被规则引用 或 仍存在于 entries（防误删）
      const keptUrl = existing.filter(
        (g: any) =>
          isUrlProxyName(g?.name ?? '') &&
          (referencedGroups.has(g.name) || entryNames.has(g.name)),
      )
      const groups = entries.map((e) => ({
        name: getGroupName(e),
        type: 'select',
        proxies: ['DIRECT', 'REJECT', ...allProxies],
      }))
      // 合并去重（既有组优先，避免同 id 的 entries 组覆盖已有 proxies）
      const byName = new Map<string, any>()
      for (const g of [...kept, ...keptUrl, ...groups]) byName.set(g.name, g)
      append = [...byName.values()]
    } else {
      append = existing.filter(
        (g: any) =>
          !isUrlProxyName(g?.name ?? '') ||
          referencedGroups.has(g.name) ||
          entryNames.has(g.name),
      )
    }

    return await saveProfileFile(
      groupsUid,
      yaml.dump(
        { prepend: obj.prepend ?? [], append, delete: obj.delete ?? [] },
        { forceQuotes: true },
      ),
    )
  } catch (e) {
    console.error('[URLProxy] 写入代理组增强失败:', e)
    return false
  }
}

/** 同步 Rules 增强文件：URL-Proxy 规则子集始终等于 entries 对应的规则
 * （自动移除已删除条目的规则、清理历史孤儿规则）
 */
async function syncRulesFile(
  rulesUid: string,
  entries: UrlProxyEntry[],
): Promise<boolean> {
  try {
    const raw = (await readProfileFile(rulesUid)) as string
    const obj = (yaml.load(raw) as any) || {}
    const existing = Array.isArray(obj.append) ? obj.append : []
    const kept = existing.filter(
      (r: any) => typeof r !== 'string' || !r.includes('URL-Proxy-'),
    )
    const rules = entries.map((e) => `DOMAIN-SUFFIX,${e.host},${getGroupName(e)}`)

    return await saveProfileFile(
      rulesUid,
      yaml.dump(
        {
          prepend: obj.prepend ?? [],
          append: [...kept, ...rules],
          delete: obj.delete ?? [],
        },
        { forceQuotes: true },
      ),
    )
  } catch (e) {
    console.error('[URLProxy] 写入规则增强失败:', e)
    return false
  }
}

/** 把 mihomo 真实生效的代理组/规则写进当前 profile 的增强文件，并触发 enhance
 *
 * 关键：mihomo 的 `PATCH /configs` 只接受 General 字段，对 `proxy-groups` /
 * `rules` 静默忽略，所以运行时建组无效。正确做法是把组写进 **Groups 增强**
 * 文件的 `append`、把规则写进 **Rules 增强** 文件的 `append`，再调
 * `enhanceProfiles()` —— 它会用完整配置 reload mihomo，组才真实存在，
 * 之后 `selectNodeForGroup` 才能工作。
 *
 * 自愈：以 localStorage 全量 entries 重建两组文件，每次操作顺带清理
 * 历史孤儿组/孤儿规则，增强文件不会因反复增删而膨胀（解决"新建多了报错"）。
 */
export async function createUrlProxyGroup(entry: UrlProxyEntry): Promise<boolean> {
  let allProxies = await fetchAllProxyNames()

  if (allProxies.length === 0) {
    // 兜底：mihomo 瞬时不响应时，用增强文件里上次成功写入的节点重建组
    allProxies = await loadProxyNamesFromEnhance()
  }

  if (allProxies.length === 0) {
    console.error('[URLProxy] 没有可用代理节点')
    return false
  }

  const uids = await getCurrentEnhancementUids()
  if (!uids?.groups || !uids?.rules) {
    console.error('[URLProxy] 当前订阅未启用"代理组/规则"增强，无法创建分组')
    return false
  }

  // 新增条目已由 addEntry 写入 localStorage，entries 为全量（含新增）
  const entries = getAllEntries()

  // 先写组（新组暂无规则引用 → 校验通过），再写规则（新规则引用已存在的组 → 校验通过）
  if (!(await syncGroupsFile(uids.groups, uids.rules, entries, allProxies)))
    return false
  if (!(await syncRulesFile(uids.rules, entries))) return false

  // 重新生成完整配置并 reload mihomo（组/规则此刻才真实存在）
  // silent=true：校验失败不弹通知（URL 代理组操作不应打扰用户）
  try {
    if (!(await enhanceProfiles(true))) {
      console.error('[URLProxy] 增强配置校验失败:', getGroupName(entry))
      return false
    }
  } catch (e) {
    console.error('[URLProxy] 增强配置失败:', e)
    return false
  }

  // 如果用户之前有选中的代理，恢复选中
  const targetProxy = entry.selectedProxy ?? entry.autoSelectedProxy
  if (targetProxy && allProxies.includes(targetProxy)) {
    try {
      await selectNodeForGroup(getGroupName(entry), targetProxy)
    } catch (e) {
      console.error('[URLProxy] 恢复选中代理失败:', e)
    }
  }

  debugLog(`[URLProxy] 代理组创建/更新成功: ${getGroupName(entry)}`)
  return true
}

/** 从当前 profile 的增强文件中删除 URL 代理组和规则，并触发 enhance
 *
 * 关键顺序：**先删规则、再删组**。
 * `save_profile_file` 每次写入都会重建并校验完整配置，若先删组，规则仍引用
 * 已删除的组 → mihomo 校验失败 → 弹出「订阅配置校验失败」并回滚文件。
 * 先删规则后组：删除瞬间组成为"孤儿组"（合法），删除组时已无规则悬空 → 校验通过。
 *
 * 同时按 localStorage 全量 entries 重建，顺带清理历史孤儿组/规则。
 */
export async function removeUrlProxyGroup(entry: UrlProxyEntry): Promise<boolean> {
  const uids = await getCurrentEnhancementUids()
  if (!uids?.groups || !uids?.rules) {
    console.warn('[URLProxy] 当前订阅未启用增强，无需清理分组')
    return false
  }

  // 条目已由页面从 localStorage 移除
  const entries = getAllEntries()

  // 先删规则（组暂时无人引用 → 校验通过）
  if (!(await syncRulesFile(uids.rules, entries))) {
    console.warn('[URLProxy] 删除规则失败，中止删除代理组（避免规则悬空）')
    return false
  }

  // 再删组（此时已无规则引用它 → 校验通过）
  const allProxies = await fetchAllProxyNames()
  if (!(await syncGroupsFile(uids.groups, uids.rules, entries, allProxies))) {
    console.warn('[URLProxy] 删除代理组失败')
    return false
  }

  try {
    await enhanceProfiles(true)
  } catch (e) {
    console.error('[URLProxy] 增强配置失败:', e)
  }
  return true
}

/** 为 URL 选择指定代理节点（与"代理"菜单同源：selectNodeForGroup）
 *
 * 自愈：如果 group 不存在导致失败，自动 ensureGroup 后重试一次。
 */
export async function selectProxyForUrl(
  entry: UrlProxyEntry,
  proxyName: string,
): Promise<boolean> {
  const groupName = getGroupName(entry)
  const trySelect = async () => {
    try {
      await selectNodeForGroup(groupName, proxyName)
      return true
    } catch (e) {
      console.warn(`[URLProxy] 选择代理首次失败: ${groupName} -> ${proxyName}`, e)
      return false
    }
  }

  if (await trySelect()) return true

  // 首次失败：可能 group 不存在，重建后再试一次
  const created = await createUrlProxyGroup(entry)
  if (!created) return false

  if (await trySelect()) return true

  console.error(`[URLProxy] 重建代理组后选择仍失败: ${groupName} -> ${proxyName}`)
  return false
}

/** 测试指定代理对某个 URL 的延迟（走 tauri-plugin-mihomo-api 标准链路） */
export async function testProxyDelay(
  proxyName: string,
  url: string,
  timeout: number = 10000,
): Promise<number> {
  try {
    const res = await delayProxyByName(proxyName, url, timeout)
    return res.delay
  } catch (e) {
    console.error('[URLProxy] 测速失败:', e)
    return -1
  }
}

/** 自动测速：并发测试可用代理，可选择延迟最低的那个（增量式提前返回）
 *
 * 复用 `delayManager.checkListDelay` 走"代理"页的标准链路：
 *  - 测试 URL = entry.url（对应当前 URL 域名的连通性）
 *  - 测速中状态为 -2，失败/超时为 1e6/0，成功为正整数
 *  - 进度通过 delayManager 通知订阅者（useProxyDelayState）自动刷新 UI
 *  - timeout 来自调用方（页面从 verge.default_latency_timeout 读取，与"代理"页同步）
 *  - selectBest=false 时仅测速（等全部完成），true 时测速并增量选最低
 *
 * 增量选择：低延迟节点通常先返回结果，无需等所有节点测完。
 * 轮询 delayManager 缓存收集"成功延迟"（>0 且 <1e6）的节点，够
 * collectTarget（默认 3，合理范围 2~5）个即从中选最低并提前返回；
 * 全部测完仍不足则从全量缓存兜底。后台未完成的测速结果仍写缓存供 UI 刷新。
 * 用轮询而非 group listener（页面 useFilterSort 已占用，避免覆盖）。
 */
export async function autoTestAndSelectBest(
  entry: UrlProxyEntry,
  timeout: number = 10000,
  selectBest: boolean = true,
  collectTarget: number = 3,
): Promise<string | null> {
  const allProxies = await fetchAllProxyNames()
  if (allProxies.length === 0) return null

  // 设置 group 维度的测试 URL（让 delayManager.checkDelay 内部用 entry.url 测速）
  delayManager.setUrl(entry.id, entry.url)

  // 构造最小 IProxyItem 列表（provider 留空，走 delayProxyByName 路径与"代理"页一致）
  const items: IProxyItem[] = allProxies.map((name) => ({
    name,
    type: 'unknown',
    udp: false,
    xudp: false,
    tfo: false,
    mptcp: false,
    smux: false,
    history: [],
  }))

  // selectBest=false：只测速，不自动选择（等全部完成）
  if (!selectBest) {
    await delayManager.checkListDelay(items, entry.id, timeout)
    return null
  }

  const groupName = entry.id
  const successful = new Set<string>()
  let settled = false
  let resolveSettled: () => void = () => {}
  const settledPromise = new Promise<void>((resolve) => {
    resolveSettled = resolve
  })

  // 从缓存收集"成功延迟"的节点（去重）；返回是否已够 collectTarget
  const collect = (): boolean => {
    for (const name of allProxies) {
      if (successful.has(name)) continue
      const u = delayManager.getDelayUpdate(name, groupName)
      if (u && u.delay > 0 && u.delay < 1e6) successful.add(name)
    }
    return successful.size >= collectTarget
  }

  let pollTimer: number | undefined
  const finish = () => {
    if (settled) return
    settled = true
    if (pollTimer !== undefined) clearInterval(pollTimer)
    resolveSettled()
  }

  // 启动批量测速（后台继续，不阻塞提前返回；结果仍写缓存供 UI 刷新）
  delayManager
    .checkListDelay(items, groupName, timeout)
    .catch(() => {})
    .finally(finish)

  // 轮询缓存：够 collectTarget 个成功结果就提前收手
  pollTimer = setInterval(() => {
    if (collect()) finish()
  }, 100)

  // 先利用已有缓存立即收集一次
  if (collect()) finish()

  await settledPromise

  // 从已测出的成功结果里选最低延迟
  let bestName: string | null = null
  let bestDelay = Number.POSITIVE_INFINITY
  for (const name of successful) {
    const d = delayManager.getDelayUpdate(name, groupName)
    if (d && d.delay > 0 && d.delay < 1e6 && d.delay < bestDelay) {
      bestName = name
      bestDelay = d.delay
    }
  }

  if (!bestName) return null

  // 选中最低延迟的节点；失败则返回 null（避免"提示成功但实际没选"）
  const ok = await selectProxyForUrl(entry, bestName)
  if (ok) {
    updateEntry(entry.id, { autoSelectedProxy: bestName, selectedProxy: bestName })
    return bestName
  }

  console.error('[URLProxy] 自动选择失败：selectProxyForUrl 返回 false')
  return null
}
