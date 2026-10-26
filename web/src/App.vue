<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import PlayerRow from './components/PlayerRow.vue'
import MatchDetail from './components/MatchDetail.vue'
import EncounterList from './components/EncounterList.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import { fetchBoard, fetchLookup, fetchStatus } from './api'
import type { BoardResponse, PlayerCard, StatusResponse } from './types'

/**
 * 只轮询轻量状态（客户端连通性 + 当前阶段，不查任何人的战绩）。
 * 战绩只在「阶段变化」或用户点「刷新」时查，避免触发客户端的战绩查询限速（R22）
 */
const STATUS_POLL_MS = 5000

const board = ref<BoardResponse | null>(null)
const status = ref<StatusResponse | null>(null)
const loading = ref(true)
const error = ref('')
const offline = ref(false)
const clock = ref('')
const refreshBusy = ref(false)

/** 两个页面：对局侦察（十人面板）/ 个人战绩（按名查询） */
const tab = ref<'board' | 'lookup'>('board')
/** 个人战绩页首次打开时默认查一次自己 */
const lookupLoaded = ref(false)

let timer: number | undefined
let alive = true
let lastKey = ''

// —— 按名字查战绩 ——
const lookupInput = ref('')
const lookup = ref<PlayerCard | null>(null)
const lookupFor = ref('')
const lookupError = ref('')
const lookupBusy = ref(false)
const lookupTookMs = ref(0)
const lookupClock = ref('')

// —— 对局详情 ——
const detailGame = ref<{ gameId: number; puuid: string; highlight: string } | null>(null)

function openDetail(player: PlayerCard | null, gameId: number): void {
  if (!player) return
  detailGame.value = { gameId, puuid: player.puuid, highlight: '' }
}

// —— 相遇清单（本地对战记录） ——
const encounterFor = ref<PlayerCard | null>(null)
/** 设置弹层（记录保存位置） */
const settingsOpen = ref(false)

/** 从相遇清单点开某一局：以我方视角看，并把这位老熟人高亮出来 */
function openEncounterGame(gameId: number): void {
  const player = encounterFor.value
  if (!player) return
  detailGame.value = {
    gameId,
    puuid: board.value?.selfPuuid || player.puuid,
    highlight: player.puuid,
  }
}

async function runLookup(text: string, puuid = '', attempt = 0): Promise<void> {
  lookupBusy.value = true
  try {
    const data = await fetchLookup(text.trim(), puuid)
    if (!alive) return
    if (!data.ok || !data.player) {
      lookup.value = null
      lookupFor.value = data.query || text
      lookupError.value = data.error ?? '查询失败'
      return
    }
    lookup.value = data.player
    lookupFor.value = data.query
    lookupError.value = ''
    lookupTookMs.value = data.tookMs
    lookupClock.value = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    // 默认查自己时，把真实 Riot ID 回填到输入框
    if (!lookupInput.value) lookupInput.value = data.query
    // 桥接侧 16 秒软上限内没取完：请求还在后台跑，隔 3 秒自动再取一次（最多 3 回）
    if (data.player.state === 'loading' && attempt < 3) {
      const forQuery = data.query
      window.setTimeout(() => {
        if (!alive || lookupBusy.value || lookupFor.value !== forQuery) return
        void runLookup(text, puuid, attempt + 1)
      }, 3000)
    }
  } catch (e) {
    if (!alive) return
    lookup.value = null
    lookupError.value = (e as Error).message
  } finally {
    lookupBusy.value = false
  }
}

function submit(): void {
  void runLookup(lookupInput.value)
}

/** 查自己：清空输入即可 */
function lookupSelf(): void {
  lookupInput.value = ''
  void runLookup('')
}

/** 面板里点名字：跳到「个人战绩」并按 puuid 直接查这个人 */
function quickLookup(player: PlayerCard): void {
  const query = player.tagLine ? `${player.gameName}#${player.tagLine}` : player.gameName
  tab.value = 'lookup'
  lookupLoaded.value = true
  lookupInput.value = query
  updateTitle()
  void runLookup(query, player.puuid)
}

/** 切页：个人战绩页第一次打开时默认查自己 */
function openTab(next: 'board' | 'lookup'): void {
  tab.value = next
  if (next === 'lookup' && !lookupLoaded.value && !lookupBusy.value) {
    lookupLoaded.value = true
    void runLookup('')
  }
  updateTitle()
}

/** 轻量状态的身份：客户端状态 + 阶段。只在这里变化时自动拉一次面板 */
function statusKey(data: StatusResponse): string {
  return `${data.client}:${data.phase ?? ''}`
}

const CLIENT_ERROR: Record<string, string> = {
  not_running: '未检测到英雄联盟客户端，请先启动客户端并登录。',
  access_denied: '当前权限不足，无法读取客户端认证信息。',
  error: '读取客户端状态失败。',
}

/** 只拉轻量状态；阶段变化时顺带拉一次面板 */
async function tick(): Promise<void> {
  const previous = lastKey
  try {
    const data = await fetchStatus()
    if (!alive) return
    offline.value = false
    status.value = data
    if (data.client !== 'connected') {
      error.value = data.error ?? CLIENT_ERROR[data.client] ?? ''
    }
    const key = statusKey(data)
    lastKey = key
    // 首次进入、客户端启动/登录、阶段切换（空闲 → 选人 → 对局 → 结算）时自动拉一次
    if (previous === '' || key !== previous) await loadBoard(false)
  } catch (e) {
    if (!alive) return
    // 拿不到响应说明桥接服务本身不可达，与「客户端异常」要分开提示
    offline.value = true
    board.value = null
    status.value = null
    lastKey = ''
    error.value = (e as Error).message
  } finally {
    loading.value = false
    updateTitle()
    schedule()
  }
}

/** 拉面板。force=true 时透传给桥接，绕过玩家缓存（用户手动刷新） */
async function loadBoard(force: boolean): Promise<void> {
  if (refreshBusy.value) return
  refreshBusy.value = true
  try {
    const data = await fetchBoard(force)
    if (!alive) return
    board.value = data
    error.value = data.ok ? '' : (data.error ?? '')
    clock.value = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  } catch (e) {
    if (!alive) return
    offline.value = true
    board.value = null
    error.value = (e as Error).message
  } finally {
    refreshBusy.value = false
    updateTitle()
  }
}

/** 手动刷新：面板页重取面板（个人战绩页用查询按钮重查） */
function refresh(): void {
  if (refreshBusy.value) return
  void loadBoard(true)
}

function schedule(delay = STATUS_POLL_MS): void {
  if (!alive) return
  if (timer) window.clearTimeout(timer)
  timer = window.setTimeout(tick, delay)
}

function updateTitle(): void {
  if (tab.value === 'lookup') {
    document.title = '个人战绩 · 峡谷斥候'
    return
  }
  document.title = kind.value === 'loading' ? '峡谷斥候' : `${title.value} · 峡谷斥候`
}

// 浏览器会把后台标签页的定时器压到每分钟一次；从游戏客户端切回来时立刻补拉一次
function wake(): void {
  if (document.visibilityState === 'visible') schedule(0)
}

/** Esc 只关最上面一层：设置 → 对局详情 → 相遇清单 */
function onEsc(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  if (settingsOpen.value) {
    settingsOpen.value = false
    return
  }
  if (detailGame.value) {
    detailGame.value = null
    return
  }
  if (encounterFor.value) encounterFor.value = null
}

onMounted(() => {
  document.addEventListener('visibilitychange', wake)
  window.addEventListener('focus', wake)
  window.addEventListener('keydown', onEsc)
  void tick()
})
onUnmounted(() => {
  alive = false
  document.removeEventListener('visibilitychange', wake)
  window.removeEventListener('focus', wake)
  window.removeEventListener('keydown', onEsc)
  if (timer) window.clearTimeout(timer)
})

const ally = computed(() => board.value?.teams.find((t) => t.side === 'ally')?.players ?? [])
const enemy = computed(() => board.value?.teams.find((t) => t.side === 'enemy')?.players ?? [])

/** 界面状态机：加载 / 空闲 / 选人中 / 对局中 / 名单生成中 / 各种异常 */
const kind = computed(() => {
  if (offline.value) return 'offline'
  if (!board.value) return 'loading'
  if (!board.value.ok) {
    if (board.value.phase === 'not_running') return 'notrunning'
    if (board.value.phase === 'access_denied') return 'denied'
    if (board.value.error?.includes('名单尚未生成')) return 'warming'
    return 'error'
  }
  if (board.value.phase === 'ChampSelect') return 'champselect'
  if (board.value.phase === 'InProgress') return 'ingame'
  return 'idle'
})

const title = computed(() => {
  switch (kind.value) {
    case 'loading':
      return '正在连接客户端'
    case 'champselect':
      return '选人中'
    case 'ingame':
      return '对局中'
    case 'idle':
      return '等待对局'
    case 'warming':
      return '正在读取对局'
    case 'offline':
      return '桥接服务未启动'
    case 'denied':
      return '需要管理员权限'
    case 'notrunning':
      return '未检测到客户端'
    default:
      return '连接异常'
  }
})

const idleSub = computed(() => {
  if (board.value?.phase === 'EndOfGame') return '上一局已结束，等待下一局…'
  return '选人开始时，这里会自动出现双方阵容'
})

/** 顶栏右侧的耗时/时间：跟着当前页面走 */
const topStats = computed(() => {
  if (tab.value === 'lookup') return lookupTookMs.value ? `${lookupTookMs.value}ms · ${lookupClock.value}` : ''
  return board.value ? `${board.value.tookMs}ms · ${clock.value}` : ''
})
</script>

<template>
  <div class="top">
    <div class="brand">
      <span class="dot" :class="kind" />
      <span>峡谷斥候</span>
      <span class="phase">{{ title }}</span>
      <span v-if="board?.gameId" class="game-id">#{{ board.gameId }}</span>
    </div>
    <div class="top-right">
      <button
        v-if="tab === 'board'"
        class="refresh-btn"
        type="button"
        :disabled="refreshBusy"
        @click="refresh"
      >
        {{ refreshBusy ? '刷新中…' : '刷新' }}
      </button>
      <span v-if="topStats">{{ topStats }}</span>
      <button class="refresh-btn ghost" type="button" title="设置：本地记录保存位置" @click="settingsOpen = true">
        设置
      </button>
    </div>
  </div>

  <nav class="tabs">
    <button
      class="tab"
      :class="{ active: tab === 'board' }"
      type="button"
      @click="openTab('board')"
    >
      对局侦察
    </button>
    <button
      class="tab"
      :class="{ active: tab === 'lookup' }"
      type="button"
      @click="openTab('lookup')"
    >
      个人战绩
    </button>
  </nav>

  <!-- 页面一：个人战绩查询 -->
  <template v-if="tab === 'lookup'">
    <form class="searchbar" @submit.prevent="submit">
      <input
        v-model="lookupInput"
        class="search-input"
        placeholder="输入召唤师名#TAG 查历史战绩"
        spellcheck="false"
        @keydown.enter.prevent="submit"
      />
      <button class="search-btn" type="submit" :disabled="lookupBusy">
        {{ lookupBusy ? '查询中…' : '查询' }}
      </button>
      <button v-if="lookupInput" class="search-btn ghost" type="button" @click="lookupSelf">
        我的战绩
      </button>
    </form>

    <section v-if="lookup" class="team">
      <div class="team-head">
        战绩查询
        <span class="query">{{ lookupFor }}</span>
      </div>
      <PlayerRow
        :player="lookup"
        :self="lookup.puuid === board?.selfPuuid"
        expanded
        @open="(id) => openDetail(lookup, id)"
        @lookup="quickLookup(lookup)"
      />
    </section>
    <div v-else-if="lookupError" class="lookup-error">{{ lookupError }}</div>
    <div v-else-if="lookupBusy" class="center-box">
      <div class="center-title">正在查询战绩…</div>
      <div class="center-sub">会尽量多拉最近的场次，冷门账号可能要几秒。</div>
    </div>
    <div v-else class="center-box">
      <div class="center-title">查一个召唤师</div>
      <div class="center-sub">输入「名字#TAG」查询历史战绩；留空则查自己。</div>
    </div>
  </template>

  <!-- 页面二：对局侦察 -->
  <template v-else>
    <div v-if="kind === 'loading'" class="center-box">
      <div class="center-title">正在连接客户端…</div>
      <div class="center-sub">首次加载需要读取英雄数据，可能要一两秒</div>
    </div>

    <div v-else-if="kind === 'offline'" class="center-box">
      <span class="badge-warn">桥接服务未启动</span>
      <div class="center-title">连不上本地服务</div>
      <div class="center-sub">请先启动桥接服务（npm start），它通常需要管理员权限。</div>
      <div class="center-sub">页面会自动重试，服务起来后无需刷新。</div>
    </div>

    <div v-else-if="kind === 'notrunning'" class="center-box">
      <span class="badge-warn">未检测到客户端</span>
      <div class="center-title">请先启动英雄联盟客户端</div>
      <div class="center-sub">{{ error }}</div>
      <div class="center-sub">程序会自动重试，启动并登录后无需任何操作。</div>
    </div>

    <div v-else-if="kind === 'denied'" class="center-box">
      <span class="badge-warn">权限不足</span>
      <div class="center-title">需要管理员权限</div>
      <div class="center-sub">{{ error }}</div>
      <div class="center-sub">
        关闭本程序后，右键选择「以管理员身份运行」重新打开即可，重新打开后会自动加载。
      </div>
    </div>

    <div v-else-if="kind === 'warming'" class="center-box">
      <div class="center-title">正在读取对局名单…</div>
      <div class="center-sub">对局刚开始时数据可能还没生成，稍等一下再点「刷新」。</div>
    </div>

    <div v-else-if="kind === 'error'" class="center-box">
      <span class="badge-warn">读取失败</span>
      <div class="center-title">暂时拿不到数据</div>
      <div class="center-sub">{{ error }}</div>
      <div class="center-sub">点右上角「刷新」重试。</div>
    </div>

    <!-- 等待对局：保留双方五人的战绩框架，进局后原地替换 -->
    <div v-else-if="kind === 'idle'">
      <div class="idle-bar">
        <span class="badge-ok">已连接客户端</span>
        <span class="idle-sub">{{ title }} · {{ idleSub }}</span>
      </div>
      <div class="board-cols">
        <section class="team">
          <div class="team-head">我方</div>
          <div v-for="i in 5" :key="i" class="placeholder-row">
            <div class="who">
              <div class="ph-avatar" />
              <div class="ph-lines"><div /><div /></div>
            </div>
            <div class="ph-games">
              <span v-for="n in 10" :key="n" class="ph-game" />
            </div>
          </div>
        </section>
        <section class="team">
          <div class="team-head enemy">敌方</div>
          <div v-for="i in 5" :key="i" class="placeholder-row">
            <div class="who">
              <div class="ph-avatar" />
              <div class="ph-lines"><div /><div /></div>
            </div>
            <div class="ph-games">
              <span v-for="n in 10" :key="n" class="ph-game" />
            </div>
          </div>
        </section>
      </div>
    </div>

    <template v-else>
      <div class="board-cols">
        <section class="team">
          <div class="team-head">我方</div>
          <PlayerRow
            v-for="p in ally"
            :key="p.puuid"
            :player="p"
            :self="p.puuid === board?.selfPuuid"
            @open="(id) => openDetail(p, id)"
            @lookup="quickLookup(p)"
            @encounters="encounterFor = p"
          />
        </section>

        <section class="team">
          <div class="team-head enemy">
            敌方
            <span v-if="board?.enemyHidden" class="locked">选人阶段官方隐藏</span>
          </div>
          <template v-if="board?.enemyHidden">
            <div v-for="i in 5" :key="i" class="placeholder-row">
              <div class="who">
                <div class="ph-avatar" />
                <div class="ph-lines"><div /><div /></div>
              </div>
              <div class="ph-games">
                <span v-for="n in 10" :key="n" class="ph-game" />
              </div>
            </div>
          </template>
          <template v-else>
            <PlayerRow
              v-for="p in enemy"
              :key="p.puuid"
              :player="p"
              :self="p.puuid === board?.selfPuuid"
              @open="(id) => openDetail(p, id)"
              @lookup="quickLookup(p)"
              @encounters="encounterFor = p"
            />
          </template>
        </section>
      </div>
    </template>
  </template>

  <EncounterList
    v-if="encounterFor"
    :player="encounterFor"
    @open="openEncounterGame"
    @close="encounterFor = null"
  />

  <MatchDetail
    v-if="detailGame"
    :game-id="detailGame.gameId"
    :puuid="detailGame.puuid"
    :highlight="detailGame.highlight"
    @close="detailGame = null"
  />

  <SettingsPanel v-if="settingsOpen" @close="settingsOpen = false" />
</template>
