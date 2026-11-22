<template>
    <v-dialog v-model="visible" persistent max-width="400">
        <v-card>
            <v-card-title class="text-h3 pa-4 pb-0 pl-6">{{ t('core.common.restart.waiting') }}</v-card-title>
            <v-card-text>
                <v-progress-linear indeterminate color="primary"></v-progress-linear>
            </v-card-text>
        </v-card>
    </v-dialog>
</template>

<script>
import { mohoApi } from '@/api/moho'
import { useCommonStore } from '@/stores/common';
import { useI18n } from '@/i18n/composables';


export default {
    name: 'WaitingForRestart',
    setup() {
        const { t } = useI18n();
        return { t };
    },
    data() {
        return {
            visible: false,
            startTime: -1,
            newStartTime: -1,
            sawDown: false,
            status: '',
            cnt: 0,
        }
    },
    methods: {
        reloadWithCacheBuster() {
            const url = new URL(window.location.href)
            url.searchParams.set('_r', Date.now().toString())
            window.location.replace(url.toString())
        },
        async check(initialStartTime = null) {
            this.newStartTime = -1
            this.cnt = 0
            this.visible = true
            this.status = ""
            // MohoBot has no start-time endpoint: restart is detected by
            // liveness (backend goes down, then answers again).
            this.startTime = -1
            this.sawDown = false
            console.log('start wfr')
            setTimeout(() => {
                this.timeoutInternal()
            }, 1000)
        },
        stop() {
            this.visible = false
            this.cnt = 0
            this.newStartTime = -1
        },
        timeoutInternal() {
            console.log('wfr: timeoutInternal', this.newStartTime, this.startTime)
            if (this.newStartTime === -1 && this.cnt < 60 && this.visible) {
                this.checkStartTime()
                this.cnt++
                setTimeout(() => {
                    this.timeoutInternal()
                }, 1000)
            } else {
                if (this.cnt >= 60) {
                    this.status = this.t('core.common.restart.maxRetriesReached')
                }
                this.cnt = 0
                setTimeout(() => {
                    this.visible = false
                }, 1000)
            }
        },
        async checkStartTime() {
            // MohoBot restart detection: the backend briefly stops answering
            // GET /api/status while it restarts. Reload once it answers again
            // after having been down (or after 10s of steady uptime, for
            // restarts too fast to observe any downtime).
            try {
                await mohoApi.runtimeStatus()
                if (this.sawDown || this.cnt >= 10) {
                    console.log('wfr: restarted')
                    this.newStartTime = 1
                    this.visible = false
                    this.reloadWithCacheBuster()
                }
            } catch (_error) {
                this.sawDown = true
            }
            return this.newStartTime
        }
    }
}
</script>
