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

// ─── Public API ──────────────────────────────────────────────────────────────

export function getAllEntries(): UrlProxyEntry[] {
  return loadEntries()
}

export function getEntry(id: string): UrlProxyEntry | undefined {
  return loadEntries().find((e) => e.id === id)
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
  saveEntries([...entries, entry])
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

/** 获取所有可用代理名称列表 */
export async function fetchAllProxyNames(): Promise<string[]> {
  try {
    const data = await getProxies()
    if (!data?.proxies) return []
    return Object.keys(data.proxies).filter(
      (name) => name !== 'GLOBAL' && name !== 'DIRECT' && name !== 'REJECT',
    )
  } catch (e) {
    console.error('[URLProxy] 获取代理列表失败:', e)
    return []
  }
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

/** 把 mihomo 真实生效的代理组/规则写进当前 profile 的增强文件，并触发 enhance
 *
 * 关键：mihomo 的 `PATCH /configs` 只接受 General 字段，对 `proxy-groups` /
 * `rules` 静默忽略，所以运行时建组无效。正确做法是把组写进 **Groups 增强**
 * 文件的 `append`、把规则写进 **Rules 增强** 文件的 `append`，再调
 * `enhanceProfiles()` —— 它会用完整配置 reload mihomo，组才真实存在，
 * 之后 `selectNodeForGroup` 才能工作。
 *
 * 幂等：同名 group / 同一条 rule 只追加一次。
 */
export async function createUrlProxyGroup(entry: UrlProxyEntry): Promise<boolean> {
  const groupName = getGroupName(entry)
  const allProxies = await fetchAllProxyNames()

  if (allProxies.length === 0) {
    console.error('[URLProxy] 没有可用代理节点')
    return false
  }

  const uids = await getCurrentEnhancementUids()
  if (!uids?.groups || !uids?.rules) {
    console.error('[URLProxy] 当前订阅未启用"代理组/规则"增强，无法创建分组')
    return false
  }

  const newRule = `DOMAIN-SUFFIX,${entry.host},${groupName}`

  // 1) 写 Groups 增强：append 一个 selector 组（含 DIRECT/REJECT 与全部节点）
  try {
    const raw = (await readProfileFile(uids.groups)) as string
    const obj = (yaml.load(raw) as any) || {}
    const append: any[] = Array.isArray(obj.append) ? obj.append : []
    if (!append.some((g: any) => g?.name === groupName)) {
      append.push({
        name: groupName,
        type: 'select',
        proxies: ['DIRECT', 'REJECT', ...allProxies],
      })
    }
    const dumped = yaml.dump(
      {
        prepend: obj.prepend ?? [],
        append,
        delete: obj.delete ?? [],
      },
      { forceQuotes: true },
    )
    await saveProfileFile(uids.groups, dumped)
  } catch (e) {
    console.error('[URLProxy] 写入代理组增强失败:', e)
    return false
  }

  // 2) 写 Rules 增强：append 一条 DOMAIN-SUFFIX 规则指向该组
  try {
    const raw = (await readProfileFile(uids.rules)) as string
    const obj = (yaml.load(raw) as any) || {}
    const append: string[] = Array.isArray(obj.append) ? obj.append : []
    if (!append.includes(newRule)) append.push(newRule)
    const dumped = yaml.dump(
      {
        prepend: obj.prepend ?? [],
        append,
        delete: obj.delete ?? [],
      },
      { forceQuotes: true },
    )
    await saveProfileFile(uids.rules, dumped)
  } catch (e) {
    console.error('[URLProxy] 写入规则增强失败:', e)
    return false
  }

  // 3) 重新生成完整配置并 reload mihomo（组/规则此刻才真实存在）
  // silent=true：校验失败不弹通知（URL 代理组操作不应打扰用户）
  try {
    await enhanceProfiles(true)
    debugLog(`[URLProxy] 代理组创建/更新成功: ${groupName}`)
  } catch (e) {
    console.error('[URLProxy] 增强配置失败:', e)
    return false
  }

  // 4) 如果用户之前有选中的代理，恢复选中
  const targetProxy = entry.selectedProxy ?? entry.autoSelectedProxy
  if (targetProxy && allProxies.includes(targetProxy)) {
    try {
      await selectNodeForGroup(groupName, targetProxy)
    } catch (e) {
      console.error('[URLProxy] 恢复选中代理失败:', e)
    }
  }

  return true
}

/** 从当前 profile 的增强文件中删除 URL 代理组和规则，并触发 enhance
 *
 * 与 createUrlProxyGroup 对称：从 Groups/Rules 增强文件的 `append` 中过滤掉
 * 对应项后写回，再 enhanceProfiles() 重建配置。
 */
export async function removeUrlProxyGroup(entry: UrlProxyEntry): Promise<void> {
  const groupName = getGroupName(entry)
  const newRule = `DOMAIN-SUFFIX,${entry.host},${groupName}`

  const uids = await getCurrentEnhancementUids()
  if (!uids?.groups || !uids?.rules) {
    console.warn('[URLProxy] 当前订阅未启用增强，无需清理分组')
    return
  }

  try {
    const raw = (await readProfileFile(uids.groups)) as string
    const obj = (yaml.load(raw) as any) || {}
    const append = (Array.isArray(obj.append) ? obj.append : []).filter(
      (g: any) => g?.name !== groupName,
    )
    await saveProfileFile(
      uids.groups,
      yaml.dump(
        { prepend: obj.prepend ?? [], append, delete: obj.delete ?? [] },
        { forceQuotes: true },
      ),
    )
  } catch (e) {
    console.error('[URLProxy] 删除代理组增强失败:', e)
  }

  try {
    const raw = (await readProfileFile(uids.rules)) as string
    const obj = (yaml.load(raw) as any) || {}
    const append = (Array.isArray(obj.append) ? obj.append : []).filter(
      (r: any) => r !== newRule,
    )
    await saveProfileFile(
      uids.rules,
      yaml.dump(
        { prepend: obj.prepend ?? [], append, delete: obj.delete ?? [] },
        { forceQuotes: true },
      ),
    )
  } catch (e) {
    console.error('[URLProxy] 删除规则增强失败:', e)
  }

  try {
    await enhanceProfiles(true)
  } catch (e) {
    console.error('[URLProxy] 增强配置失败:', e)
  }
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

/** 自动测速：测试所有可用代理，可选择延迟最低的那个
 *
 * 重构后：复用 `delayManager.checkListDelay` 走"代理"页的标准链路
 *  - 测试 URL = entry.url（对应当前 URL 域名的连通性）
 *  - 测速中状态为 -2，失败/超时为 1e6/0，成功为正整数
 *  - 进度通过 delayManager 通知订阅者（useProxyDelayState）自动刷新 UI
 *  - timeout 来自调用方（页面从 verge.default_latency_timeout 读取，与"代理"页同步）
 *  - selectBest=false 时仅测速（用于 autoSelect 关闭的栏），true 时测速并选最低
 */
export async function autoTestAndSelectBest(
  entry: UrlProxyEntry,
  timeout: number = 10000,
  selectBest: boolean = true,
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

  // 批量测速（写入 delayManager cache，订阅者自动收到通知）
  await delayManager.checkListDelay(items, entry.id, timeout)

  // selectBest=false：只测速，不自动选择
  if (!selectBest) return null

  // 从缓存里挑出有效延迟里最低的（>0 且 < 1e6；0 是超时、1e6 是错误）
  let bestName: string | null = null
  let bestDelay = Number.POSITIVE_INFINITY
  for (const name of allProxies) {
    const d = delayManager.getDelayUpdate(name, entry.id)
    if (!d) continue
    if (d.delay > 0 && d.delay < 1e6 && d.delay < bestDelay) {
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
