<script setup lang="ts">
import { computed } from 'vue'
import { iconUrl, profileIconUrl } from '../api'
import type { PlayerCard } from '../types'

const props = defineProps<{ player: PlayerCard; self: boolean; expanded?: boolean }>()
const emit = defineEmits<{ open: [gameId: number]; lookup: [] }>()

const tierClass = computed(() => {
  const tier = props.player.rank?.tier
  return tier ? `tier-${tier.toLowerCase()}` : 'tier-none'
})

const summary = computed(() => {
  const games = props.player.recent
  if (!games.length) return ''
  const wins = games.filter((g) => g.win).length
  return `${wins}胜${games.length - wins}负`
})

// 段位状态分开显示：查到了 / 确实没打过排位 / 查询失败 / 还在读
const rankText = computed(() => {
  if (props.player.rankState === 'loading') return '读取中'
  if (props.player.rankState === 'error') return '段位读取失败'
  if (props.player.rankState === 'unranked') return '无排位'
  return props.player.rank?.label ?? '无排位'
})

const stateText = computed(() => {
  if (props.player.state === 'loading') return '正在读取战绩…'
  if (props.player.state === 'hidden') return '战绩已隐藏'
  if (props.player.state === 'error') return props.player.error ?? '读取失败'
  return '暂无近期战绩'
})

function kda(g: { kills: number; deaths: number; assists: number }): string {
  return `${g.kills}/${g.deaths}/${g.assists}`
}
</script>

<template>
  <div class="row" :class="[player.side, { self }]">
    <div
      class="who link"
      role="button"
      tabindex="0"
      :title="`查看 ${player.gameName} 的历史战绩`"
      @click="emit('lookup')"
      @keydown.enter.prevent="emit('lookup')"
      @keydown.space.prevent="emit('lookup')"
    >
      <div class="avatar">
        <img
          v-if="player.profileIconId"
          :src="profileIconUrl(player.profileIconId)"
          :alt="player.gameName"
          loading="lazy"
        />
        <span v-else class="qmark">?</span>
      </div>
      <div class="meta">
        <div class="name-line">
          <img
            v-if="player.championId"
            class="champ"
            :src="iconUrl(player.championId)"
            :alt="player.championName ?? ''"
            :title="player.championName ?? ''"
            loading="lazy"
          />
          <span class="name" :title="`${player.gameName}#${player.tagLine}`">
            {{ player.gameName || '未知玩家' }}
          </span>
          <span class="tag">#{{ player.tagLine }}</span>
          <span v-if="self" class="me">我</span>
        </div>
        <div class="rank-line">
          <span class="rank" :class="tierClass">{{ rankText }}</span>
          <span v-if="summary" class="summary">{{ summary }}</span>
        </div>
      </div>
    </div>

    <div v-if="player.state === 'ok'" class="games" :class="{ expanded }">
      <button
        v-for="g in player.recent"
        :key="g.gameId"
        type="button"
        class="game"
        :class="g.win ? 'win' : 'lose'"
        :title="`${g.win ? '胜' : '负'} · ${g.queueName ?? '未知模式'} · ${g.championName ?? g.championId} · ${kda(g)}`"
        @click="emit('open', g.gameId)"
      >
        <span class="mode">{{ g.queueName ?? '未知' }}</span>
        <img class="gicon" :src="iconUrl(g.championId)" alt="" loading="lazy" />
        <span class="kda">{{ kda(g) }}</span>
      </button>
    </div>
    <div v-else class="state" :class="player.state">{{ stateText }}</div>
  </div>
</template>
