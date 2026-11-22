import { defineStore } from "pinia";
import { mohoApi } from "@/api/moho";

export const useCommonStore = defineStore("common", {
  state: () => ({
    startTime: -1,
    astrbotVersion: "",
    dashboardVersion: "",

    pluginMarketData: [],
    pluginMarketDataBySource: {},
  }),
  actions: {
    // MohoBot exposes no process start-time endpoint (GET /api/status only
    // returns the current time and bot snapshots), so restart detection is
    // done by probing liveness instead: see probeBackend().
    async fetchStartTime() {
      return 0;
    },
    // True when the MohoBot backend answers GET /api/status, false otherwise.
    async probeBackend() {
      try {
        await mohoApi.runtimeStatus();
        return true;
      } catch (_error) {
        return false;
      }
    },
    setAstrBotVersion(version, dashboardVersion = "") {
      this.astrbotVersion = String(version || "").replace(/^v/i, "");
      this.dashboardVersion = String(dashboardVersion || "");
    },
    // MohoBot has no version endpoint (GET /api/status carries no version),
    // so the sidebar version stays blank until the backend adds one.
    async fetchAstrBotVersion(force = false) {
      return this.astrbotVersion;
    },
    getStartTime() {
      if (this.startTime !== -1) {
        return this.startTime;
      }
      this.fetchStartTime().catch(() => {});
      return this.startTime;
    },
    // MohoBot has no plugin market: this never hits the network and always
    // returns an empty collection. Callers (update checks, source binding)
    // treat an empty market as "no updates available".
    async getPluginCollections() {
      return [];
    },
  },
});
