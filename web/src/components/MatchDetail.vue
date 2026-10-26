<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  augmentIconUrl,
  fetchMatchDetail,
  iconUrl,
  itemIconUrl,
  profileIconUrl,
  spellIconUrl,
} from '../api'
import type { MatchDetailResponse } from '../types'

const props = withDefaults(defineProps<{ gameId: number; puuid: string; highlight?: string }>(), {
  highlight: '',
})
const emit = defineEmits<{ close: [] }>()

const data = ref<MatchDetailResponse | null>(null)
const error = ref('')

const win = computed(() => data.value?.teams[0]?.players[0]?.win ?? null)

function duration(sec: number | null): string {
  if (!sec) return '--:--'
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function when(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function num(n: number): string {
  return n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

// Esc 关闭由 App 统一处理（叠了相遇清单时先关详情）
onMounted(async () => {
  try {
    const res = await fetchMatchDetail(props.gameId, props.puuid)
    if (!res.ok) {
      error.value = res.error ?? '对局详情读取失败'
      return
    }
    data.value = res
  } catch (e) {
    error.value = (e as Error).message
  }
})
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="detail">
      <header class="detail-head">
        <div class="detail-title">
          <span v-if="win !== null" class="result" :class="win ? 'win' : 'lose'">
            {{ win ? '胜利' : '失败' }}
          </span>
          <span v-if="data">{{ data.queueName ?? '未知模式' }}</span>
          <span class="dim">{{ duration(data?.durationSec ?? null) }}</span>
          <span class="dim">{{ when(data?.endedAt ?? null) }}</span>
        </div>
        <button class="detail-close" type="button" title="关闭（Esc）" @click="emit('close')">×</button>
      </header>

      <div v-if="error" class="detail-error">{{ error }}</div>
      <div v-else-if="!data" class="detail-loading">正在读取对局详情…</div>

      <template v-else>
        <section v-for="team in data.teams" :key="team.side" class="detail-team">
          <div class="team-head" :class="team.side">
            {{ team.side === 'ally' ? '我方' : '敌方' }}
            <span class="dim">
              {{ team.players.filter((p) => p.win).length ? '胜利' : '失败' }}
              · {{ team.players.length }} 人
            </span>
          </div>
          <div class="dtable">
            <div class="drow dhead">
              <span>英雄</span>
              <span>玩家</span>
              <span>KDA</span>
              <span>补刀</span>
              <span>金币</span>
              <span>伤害</span>
              <span>视野</span>
              <span>装备</span>
            </div>
            <div
              v-for="p in team.players"
              :key="p.puuid + p.championId"
              class="dplayer"
              :class="[team.side, { hit: highlight && p.puuid === highlight }]"
            >
              <div class="drow">
                <span class="dchamp">
                  <img :src="iconUrl(p.championId)" alt="" loading="lazy" />
                  <span class="dlevel">{{ p.level }}</span>
                  <span class="dspells">
                    <img v-for="s in p.spells" :key="s" :src="spellIconUrl(s)" alt="" loading="lazy" />
                  </span>
                </span>
                <span class="dwho">
                  <img
                    v-if="p.profileIconId"
                    class="davatar"
                    :src="profileIconUrl(p.profileIconId)"
                    alt=""
                    loading="lazy"
                  />
                  <span class="dname" :title="`${p.gameName}#${p.tagLine}`"
                    >{{ p.gameName }}<span class="dtag">#{{ p.tagLine }}</span></span
                  >
                  <!-- 海克斯类模式专属：填在玩家名右侧的空位，悬停显示名称 -->
                  <span v-if="p.augments.length" class="daugments">
                    <span
                      v-for="a in p.augments"
                      :key="a.id"
                      class="daugment"
                      :class="a.rarity ? `r-${a.rarity}` : ''"
                      :data-name="a.name"
                    >
                      <img :src="augmentIconUrl(a.id)" alt="" loading="lazy" />
                    </span>
                  </span>
                </span>
                <span class="dkda">{{ p.kills }}/{{ p.deaths }}/{{ p.assists }}</span>
                <span>{{ p.cs }}</span>
                <span>{{ num(p.gold) }}</span>
                <span>{{ num(p.damage) }}</span>
                <span>{{ p.vision }}</span>
                <span class="ditems">
                  <img v-for="id in p.items" :key="id" :src="itemIconUrl(id)" alt="" loading="lazy" />
                  <!-- 饰品固定靠右，与其余装备拉开 -->
                  <img
                    v-if="p.trinket"
                    class="dtrinket"
                    :src="itemIconUrl(p.trinket)"
                    alt=""
                    loading="lazy"
                  />
                </span>
              </div>
            </div>
          </div>
        </section>
      </template>
    </div>
  </div>
</template>
