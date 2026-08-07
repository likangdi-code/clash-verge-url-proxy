import {
  AccessTimeRounded,
  AddRounded,
  AutoModeRounded,
  DeleteOutlined,
  ExpandLessRounded,
  ExpandMoreRounded,
  FilterAltOffRounded,
  FilterAltRounded,
  FlashOnRounded,
  HelpOutlineRounded,
  LinkRounded,
  MyLocationRounded,
  NetworkCheckRounded,
  SortByAlphaRounded,
  SortRounded,
  VisibilityOffRounded,
  VisibilityRounded,
} from '@mui/icons-material'
import {
  alpha,
  Box,
  Button,
  Chip,
  IconButton,
  ListItemButton,
  ListItemText,
  TextField,
  Tooltip,
  Typography,
  styled,
} from '@mui/material'
import { useLockFn } from 'ahooks'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { BasePage } from '@/components/base'
import { ProxyItemMini } from '@/components/proxy/proxy-item-mini'
import useFilterSort, {
  type ProxySortType,
} from '@/components/proxy/use-filter-sort'
import { useVerge } from '@/hooks/use-verge'
import { calcuProxies } from '@/services/cmds'
import { showNotice } from '@/services/notice-service'
import { useThemeMode } from '@/services/states'

import {
  getAllEntries,
  getEntry,
  addEntry,
  removeEntry,
  updateEntry,
  autoTestAndSelectBest,
  selectProxyForUrl,
  createUrlProxyGroup,
  removeUrlProxyGroup,
  type UrlProxyEntry,
} from '@/services/url-proxy'

// ─── 复用代理组的视觉常量 ────────────────────────────────────────────────────

const StyledTypeBox = styled(Box)(({ theme }) => ({
  display: 'inline-block',
  border: '1px solid #ccc',
  borderColor: alpha(theme.palette.primary.main, 0.5),
  color: alpha(theme.palette.primary.main, 0.8),
  borderRadius: 4,
  fontSize: 10,
  padding: '0 4px',
  lineHeight: 1.5,
  marginRight: '8px',
}))

const StyledPrimary = styled('span')`
  font-size: 16px;
  font-weight: 700;
  line-height: 1.5;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const StyledSubtitle = styled('span')`
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

function hostLabel(host: string): string {
  const s = host.startsWith('www.') ? host.slice(4) : host
  const parts = s.split('.')
  return parts.length >= 2 ? parts.slice(-2).join('.') : s
}

function makeFallbackItem(name: string): IProxyItem {
  return {
    name,
    type: 'unknown',
    udp: false,
    xudp: false,
    tfo: false,
    mptcp: false,
    smux: false,
    history: [],
  } as IProxyItem
}

// ─── 单个 URL 条目（完全复刻"代理"页：每组独立持有排序/显示/过滤状态） ──

interface RowProps {
  entry: UrlProxyEntry
  allProxyItems: IProxyItem[]
  latencyTimeout: number
  cardBg: string
  isDark: boolean
  itemRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>
  onDelete: (id: string) => void
  onEntriesChanged: () => void
}

const UrlEntryRow = ({
  entry,
  allProxyItems,
  latencyTimeout,
  cardBg,
  isDark: _isDark,
  itemRefs,
  onDelete,
  onEntriesChanged,
}: RowProps) => {
  const { t: _t } = useTranslation()
  const t = _t as (key: string, opts?: any) => string

  // 每个 entry 独立的视图状态（与"代理"页每个组独立的 HeadState 对齐）
  const [open, setOpen] = useState(false)
  const [showType, setShowType] = useState(true)
  const [sortType, setSortType] = useState<ProxySortType>(0)
  const [filterText, setFilterText] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  const [testing, setTesting] = useState(false)

  const autoSelect = entry.autoSelect ?? false

  // 复用"代理"页同款过滤+排序逻辑：按 entry.id 维度查延迟并排序
  const sorted = useFilterSort(allProxyItems, entry.id, filterText, sortType)

  const isOnion = entry.host.endsWith('.onion')

  const handleLocate = useCallback(() => {
    const node = itemRefs.current[entry.id]
    node?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [entry.id, itemRefs])

  const handleTest = useLockFn(async () => {
    if (testing) return
    setTesting(true)
    try {
      // autoSelect 开启：测速并自动选最低延迟节点；关闭：仅测速
      const best = await autoTestAndSelectBest(entry, latencyTimeout, autoSelect)
      if (autoSelect) {
        if (best) {
          showNotice.success(t('urlProxies.notices.testSuccess'))
        } else {
          showNotice.error(t('urlProxies.notices.testFail'))
        }
      }
      onEntriesChanged()
    } catch (err) {
      console.error(err)
      showNotice.error(t('urlProxies.notices.testFail'))
    } finally {
      setTesting(false)
    }
  })

  // autoSelect 开启时，挂载后自动跑一次测速+选最低（"刷新后自动选择延迟最低的节点"）
  useEffect(() => {
    if (!autoSelect) return
    let cancelled = false
    setTesting(true)
    autoTestAndSelectBest(entry, latencyTimeout, true)
      .then((best) => {
        if (!cancelled && best) {
          showNotice.success(
            t('urlProxies.notices.testSuccess'),
          )
        }
        if (!cancelled) onEntriesChanged()
      })
      .catch((e) => console.error(e))
      .finally(() => {
        if (!cancelled) setTesting(false)
      })
    return () => {
      cancelled = true
    }
    // 仅在 autoSelect 由 false→true 或首次挂载 autoSelect=true 时触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSelect])

  const handleToggleAutoSelect = useCallback(() => {
    updateEntry(entry.id, { autoSelect: !autoSelect })
    onEntriesChanged()
  }, [autoSelect, entry.id, onEntriesChanged])

  const handleSelect = useLockFn(async (name: string) => {
    try {
      const ok = await selectProxyForUrl(entry, name)
      if (ok) {
        updateEntry(entry.id, { selectedProxy: name, autoSelectedProxy: name })
        showNotice.success(t('urlProxies.notices.selectSuccess'))
      } else {
        showNotice.error(t('urlProxies.notices.selectFail'))
      }
      onEntriesChanged()
    } catch (e) {
      console.error(e)
    }
  })

  const virtualGroup: IProxyGroupItem = {
    name: entry.id,
    type: 'Selector',
    now: entry.selectedProxy ?? '',
    all: sorted,
    udp: false,
    xudp: false,
    tfo: false,
    mptcp: false,
    smux: false,
    history: [],
  }

  return (
    <Box sx={{ mb: 1, px: 1, pt: 0.5 }}>
      {/* 网址栏：单一背景（与"代理"页 ProxyRender 的 ListItemButton 一致，无 sticky 外层背景） */}
      <ListItemButton
        dense
        onClick={() => setOpen((p) => !p)}
        sx={{
          borderRadius: 1.5,
          bgcolor: cardBg,
          pl: 1.5,
          pr: 1,
        }}
      >
        <ListItemText
          sx={{ minWidth: 0, flex: '0 1 auto' }}
          primary={
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                overflow: 'hidden',
              }}
            >
              <StyledPrimary>{hostLabel(entry.host)}</StyledPrimary>
              {isOnion && (
                <Chip
                  size="small"
                  label="TOR"
                  color="warning"
                  sx={{ ml: 1, height: 20, fontSize: 11 }}
                />
              )}
              {autoSelect && (
                <Chip
                  size="small"
                  label="AUTO"
                  color="primary"
                  variant="outlined"
                  sx={{ ml: 1, height: 20, fontSize: 11 }}
                />
              )}
            </Box>
          }
          secondary={
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                pt: 0.5,
                overflow: 'hidden',
                whiteSpace: 'nowrap',
              }}
            >
              <Box
                sx={{
                  marginTop: '2px',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                <StyledTypeBox>URL</StyledTypeBox>
                <StyledSubtitle sx={{ color: 'text.secondary' }}>
                  {entry.selectedProxy ?? t('urlProxies.page.labels.unselected')}
                </StyledSubtitle>
              </Box>
            </Box>
          }
          slotProps={{ secondary: { component: 'div' } }}
        />

        {/* 右侧图标（与"代理"页 ProxyGroupTools 对齐：定位/测延迟/自动选择/排序/显示/过滤 + 删除 + 展开） */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.25,
            ml: 'auto',
            flex: '0 0 auto',
          }}
        >
          <Tooltip title={t('proxies.page.tooltips.locate')} arrow>
            <IconButton
              size="small"
              color="inherit"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                handleLocate()
              }}
            >
              <MyLocationRounded fontSize="inherit" />
            </IconButton>
          </Tooltip>

          <Tooltip title={t('proxies.page.tooltips.delayCheck')} arrow>
            <IconButton
              size="small"
              color="inherit"
              disabled={testing}
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                handleTest()
              }}
            >
              {testing ? (
                <FlashOnRounded fontSize="inherit" />
              ) : (
                <NetworkCheckRounded fontSize="inherit" />
              )}
            </IconButton>
          </Tooltip>

          <Tooltip
            title={
              autoSelect
                ? t('urlProxies.page.tooltips.autoSelectOn')
                : t('urlProxies.page.tooltips.autoSelectOff')
            }
            arrow
          >
            <IconButton
              size="small"
              color={autoSelect ? 'primary' : 'inherit'}
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                handleToggleAutoSelect()
              }}
            >
              <AutoModeRounded fontSize="inherit" />
            </IconButton>
          </Tooltip>

          <Tooltip
            title={
              [
                t('proxies.page.tooltips.sortDefault'),
                t('proxies.page.tooltips.sortDelay'),
                t('proxies.page.tooltips.sortName'),
              ][sortType]
            }
            arrow
          >
            <IconButton
              size="small"
              color="inherit"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setSortType(((sortType + 1) % 3) as ProxySortType)
              }}
            >
              {sortType !== 1 && sortType !== 2 && (
                <SortRounded fontSize="inherit" />
              )}
              {sortType === 1 && <AccessTimeRounded fontSize="inherit" />}
              {sortType === 2 && <SortByAlphaRounded fontSize="inherit" />}
            </IconButton>
          </Tooltip>

          <Tooltip
            title={
              showType
                ? t('proxies.page.tooltips.showBasic')
                : t('proxies.page.tooltips.showDetail')
            }
            arrow
          >
            <IconButton
              size="small"
              color="inherit"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setShowType((v) => !v)
              }}
            >
              {showType ? (
                <VisibilityRounded fontSize="inherit" />
              ) : (
                <VisibilityOffRounded fontSize="inherit" />
              )}
            </IconButton>
          </Tooltip>

          <Tooltip title={t('proxies.page.tooltips.filter')} arrow>
            <IconButton
              size="small"
              color="inherit"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                // 对齐"代理"页 ProxyGroupTools：点过滤按钮时若未展开先展开，确保搜索框可见
                if (!open) setOpen(true)
                setFilterOpen((v) => !v)
              }}
            >
              {filterOpen ? (
                <FilterAltRounded fontSize="inherit" />
              ) : (
                <FilterAltOffRounded fontSize="inherit" />
              )}
            </IconButton>
          </Tooltip>

          <Tooltip title={t('urlProxies.page.tooltips.delete')} arrow>
            <IconButton
              size="small"
              color="inherit"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                onDelete(entry.id)
              }}
            >
              <DeleteOutlined fontSize="inherit" />
            </IconButton>
          </Tooltip>

          {open ? <ExpandLessRounded /> : <ExpandMoreRounded />}
        </Box>
      </ListItemButton>

      {open && (
        <>
          {filterOpen && (
            <Box sx={{ px: 2, py: 0.5 }}>
              <TextField
                size="small"
                fullWidth
                autoFocus
                variant="outlined"
                placeholder={t('urlProxies.page.placeholders.filter')}
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.preventDefault()
                }}
              />
            </Box>
          )}

          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: 0.75,
              px: 2,
              py: 1,
            }}
          >
            {sorted.length === 0 && (
              <Typography
                variant="body2"
                sx={{
                  py: 2,
                  color: 'text.secondary',
                  gridColumn: '1 / -1',
                }}
              >
                {t('urlProxies.messages.noProxies')}
              </Typography>
            )}
            {sorted.map((proxy) => {
              const sel = entry.selectedProxy === proxy.name
              return (
                <ProxyItemMini
                  key={proxy.name}
                  group={virtualGroup}
                  proxy={proxy}
                  selected={sel}
                  showType={showType}
                  onClick={() => handleSelect(proxy.name)}
                />
              )
            })}
          </Box>
        </>
      )}
    </Box>
  )
}

// ─── 页面（顶部菜单：仅 URL 输入框 + 新建按钮） ──────────────────────────────

const UrlProxiesPage = () => {
  const { t: _t } = useTranslation()
  const t = _t as (key: string, opts?: any) => string

  const mode = useThemeMode()
  const isDark = mode === 'dark'
  const cardBg = isDark ? '#282A36' : '#ffffff'
  const { verge } = useVerge()
  // 与"代理"菜单同步：使用 verge.default_latency_timeout（默认 10000ms）
  const latencyTimeout = verge?.default_latency_timeout || 10000

  const [urlInput, setUrlInput] = useState('')
  const [entries, setEntries] = useState<UrlProxyEntry[]>(getAllEntries)
  const [allProxies, setAllProxies] = useState<string[]>([])
  const [proxyRecords, setProxyRecords] = useState<Record<string, IProxyItem>>({})
  const [creating, setCreating] = useState(false)

  const itemRefs = useRef<Record<string, HTMLDivElement | null>>({})

  useEffect(() => {
    calcuProxies()
      .then((d) => {
        setProxyRecords(d.records)
        setAllProxies([
          'DIRECT',
          ...Object.keys(d.records).filter(
            (n) => n !== 'GLOBAL' && n !== 'DIRECT' && n !== 'REJECT',
          ),
        ])
      })
      .catch(() => {})
  }, [])

  // 全量代理条目（每个 entry 共享，过滤/排序发生在各行内部）
  const allProxyItems = useMemo<IProxyItem[]>(
    () =>
      allProxies.map((name) => proxyRecords[name] ?? makeFallbackItem(name)),
    [allProxies, proxyRecords],
  )

  const flush = useCallback(() => setEntries(getAllEntries()), [])

  const handleAdd = useLockFn(async () => {
    const v = urlInput.trim()
    if (!v) return
    const entry = addEntry(v)
    if (!entry) {
      showNotice.error(t('urlProxies.notices.addFail'))
      return
    }
    setUrlInput('')
    setCreating(true)
    try {
      const ok = await createUrlProxyGroup(entry)
      if (ok) {
        showNotice.success(t('urlProxies.notices.addSuccess'))
      } else {
        showNotice.error(t('urlProxies.notices.addFail'))
      }
    } catch (e) {
      console.error(e)
      showNotice.error(t('urlProxies.notices.addFail'))
    } finally {
      setCreating(false)
      flush()
    }
  })

  const handleDelete = useLockFn(async (id: string) => {
    const entry = getEntry(id)
    removeEntry(id)
    // 同步清理当前 profile 增强文件里的分组与规则，避免留下孤儿代理组
    if (entry) {
      try {
        await removeUrlProxyGroup(entry)
      } catch (e) {
        console.error(e)
      }
    }
    flush()
  })

  return (
    <BasePage
      full
      contentStyle={{ height: '100%' }}
      header={
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            width: '100%',
          }}
        >
          <Tooltip title={t('urlProxies.page.tooltips.pageInfo')} arrow>
            <IconButton size="small" sx={{ flex: '0 0 auto' }}>
              <HelpOutlineRounded fontSize="small" />
            </IconButton>
          </Tooltip>
          <TextField
            size="small"
            fullWidth
            variant="outlined"
            placeholder={t('urlProxies.page.inputPlaceholder')}
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && urlInput.trim()) {
                e.preventDefault()
                handleAdd()
              }
            }}
            sx={{ flex: 1, minWidth: 0 }}
          />
          <Tooltip title={t('urlProxies.page.tooltips.add')} arrow>
            <span>
              <Button
                size="small"
                variant="contained"
                startIcon={<AddRounded />}
                disabled={creating || !urlInput.trim()}
                onClick={() => handleAdd()}
                sx={{ minWidth: 0, px: 1.25 }}
              >
                {t('urlProxies.page.addButton')}
              </Button>
            </span>
          </Tooltip>
        </Box>
      }
    >
      {entries.length === 0 ? (
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            py: 8,
            color: 'text.secondary',
          }}
        >
          <LinkRounded sx={{ fontSize: 64, mb: 2, opacity: 0.4 }} />
          <Typography>{t('urlProxies.notices.empty')}</Typography>
          <Typography variant="body2" sx={{ mt: 1, opacity: 0.6 }}>
            {t('urlProxies.notices.emptyHint')}
          </Typography>
          <Typography variant="body2" sx={{ opacity: 0.5 }}>
            {t('urlProxies.notices.torHint')}
          </Typography>
        </Box>
      ) : (
        <Box sx={{ height: '100%', overflow: 'auto', pb: 2 }}>
          {entries.map((entry) => (
            <Box
              key={entry.id}
              ref={(el: HTMLDivElement | null) => {
                itemRefs.current[entry.id] = el
              }}
            >
              <UrlEntryRow
                entry={entry}
                allProxyItems={allProxyItems}
                latencyTimeout={latencyTimeout}
                cardBg={cardBg}
                isDark={isDark}
                itemRefs={itemRefs}
                onDelete={handleDelete}
                onEntriesChanged={flush}
              />
            </Box>
          ))}
        </Box>
      )}
    </BasePage>
  )
}

export default UrlProxiesPage
