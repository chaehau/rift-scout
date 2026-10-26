<script setup lang="ts">
// 相遇清单：这个人以前在哪几局出现过。点任意一局看那局的完整战绩
// Esc 由 App 统一处理（详情压在清单上面时先关详情）
import { iconUrl } from '../api'
import type { PlayerCard } from '../types'

defineProps<{ player: PlayerCard }>()
const emit = defineEmits<{ close: []; open: [gameId: number] }>()

function when(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="detail met-panel">
      <header class="detail-head">
        <div class="detail-title">
          <span>遇到过</span>
          <span class="met-name">{{ player.gameName }}<span class="dtag">#{{ player.tagLine }}</span></span>
          <span class="dim">共 {{ player.met }} 次</span>
        </div>
        <button class="detail-close" type="button" title="关闭（Esc）" @click="emit('close')">×</button>
      </header>

      <div v-if="!player.metGames.length" class="detail-loading">本地还没有记录到与这名玩家的对局。</div>
      <ul v-else class="met-list">
        <li v-for="g in player.metGames" :key="g.gameId">
          <button
            class="met-item"
            type="button"
            :title="`查看对局 #${g.gameId} 的完整战绩`"
            @click="emit('open', g.gameId)"
          >
            <img class="gicon" :src="iconUrl(g.championId)" alt="" loading="lazy" />
            <span class="met-info">
              <span class="met-mode">
                {{ g.queueName ?? '未知模式' }}
                <span class="met-champ">{{ g.championName ?? '' }}</span>
              </span>
              <span class="met-time">{{ when(g.recordedAt) }}</span>
            </span>
            <span class="met-side" :class="g.ally ? 'ally' : 'enemy'">
              {{ g.ally ? '同队' : '对面' }}
            </span>
            <span class="met-id">#{{ g.gameId }}</span>
          </button>
        </li>
      </ul>

      <div class="met-tip">
        记录来自本机看到过的对局，最多保留 400 局；数据只存在本地。
      </div>
    </div>
  </div>
</template>
