<script setup lang="ts">
// 设置页：目前只有「本地对战记录的保存位置」（DEC-023）
import { computed, onMounted, ref } from 'vue'
import { fetchSettings, saveSettings } from '../api'
import type { SettingsResponse } from '../types'

const emit = defineEmits<{ close: [] }>()

const data = ref<SettingsResponse | null>(null)
const input = ref('')
const loading = ref(true)
const saving = ref(false)
const loadError = ref('')
const notice = ref('')

/** 只有 Electron 外壳注入了原生目录选择；纯浏览器里只能手输路径 */
const canPick = computed(() => typeof window !== 'undefined' && Boolean(window.rift))

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    const res = await fetchSettings()
    data.value = res
    input.value = res.dataDir
  } catch (e) {
    loadError.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

async function pick(): Promise<void> {
  const dir = await window.rift?.pickFolder()
  if (dir) input.value = dir
}

async function save(reset = false): Promise<void> {
  if (saving.value || !data.value) return
  saving.value = true
  notice.value = ''
  try {
    const res = await saveSettings(reset ? '' : input.value)
    data.value = res
    if (!res.ok) {
      notice.value = res.error ?? '保存失败'
      return
    }
    input.value = res.dataDir
    notice.value =
      res.mode === 'unchanged'
        ? `保存位置没有变化（当前 ${res.count} 局）`
        : res.mode === 'copied'
          ? `已切换，当前 ${res.count} 局记录已复制到新目录`
          : res.mode === 'existing'
            ? `已切换，读取新目录里已有的 ${res.count} 局记录`
            : '已切换，新目录暂无记录'
  } catch (e) {
    notice.value = (e as Error).message
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="detail settings-panel">
      <header class="detail-head">
        <div class="detail-title">
          <span>设置</span>
          <span class="dim">本地对战记录</span>
        </div>
        <button class="detail-close" type="button" title="关闭（Esc）" @click="emit('close')">×</button>
      </header>

      <div class="set-body">
        <div v-if="loading" class="detail-loading">正在读取设置…</div>
        <div v-else-if="loadError" class="lookup-error">{{ loadError }}</div>

        <template v-else>
          <label class="set-label" for="set-dir">记录保存位置</label>
          <div class="set-row">
            <input
              id="set-dir"
              v-model="input"
              class="search-input"
              spellcheck="false"
              placeholder="例如 D:\峡谷斥候记录"
            />
            <button v-if="canPick" class="search-btn ghost" type="button" @click="pick">
              选择文件夹…
            </button>
          </div>

          <div class="set-hint">
            当前文件：<code>{{ data?.file }}</code>
          </div>
          <div class="set-hint">
            已记录 {{ data?.count ?? 0 }} 局 · 默认位置 <code>{{ data?.defaultDir }}</code>
          </div>

          <div v-if="data?.envOverride" class="set-warn">
            当前由 RIFT_SCOUT_DATA 环境变量指定，界面修改不会生效。
          </div>

          <div class="set-note">
            换到新目录时：新目录还没有记录文件，会把当前记录复制过去；已有记录文件则改为读取那份。
            记录只保存在本机，最多 400 局。
          </div>

          <div v-if="notice" class="set-notice">{{ notice }}</div>

          <div class="set-actions">
            <button class="search-btn" type="button" :disabled="saving" @click="save(false)">
              {{ saving ? '保存中…' : '保存' }}
            </button>
            <button class="search-btn ghost" type="button" :disabled="saving" @click="save(true)">
              恢复默认位置
            </button>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
