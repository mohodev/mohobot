import {
  EXTENSION_DETAILS_ROUTE_NAME,
  EXTENSION_ROUTE_NAME
} from './routeConstants.mjs';
import type { RouteLocationNormalized } from 'vue-router';

const redirectToDataTab = (name: string) => (to: RouteLocationNormalized) => ({
  name,
  query: to.query,
  hash: to.hash
});

const MainRoutes = {
  path: '/main',
  meta: {
    requiresAuth: true
  },
  redirect: '/welcome',
  component: () => import('@/layouts/full/FullLayout.vue'),
  children: [
    {
      name: 'MainPage',
      path: '/',
      component: () => import('@/views/WelcomePage.vue')
    },
    {
      name: 'Welcome',
      path: '/welcome',
      component: () => import('@/views/WelcomePage.vue')
    },
    {
      path: '/extension',
      component: () => import('@/views/extension/PluginWorkspacePage.vue'),
      children: [
        {
          path: '',
          redirect: (to: RouteLocationNormalized) => {
            const legacyTab = String(to.hash || '').replace(/^#/, '');
            const routeNames: Record<string, string> = {
              mcp: 'ExtensionMcp',
            };
            return {
              name: routeNames[legacyTab] || EXTENSION_ROUTE_NAME,
              query: to.query
            };
          }
        },
        {
          name: EXTENSION_ROUTE_NAME,
          path: 'plugins',
          component: () => import('@/views/ExtensionPage.vue'),
          props: { initialTab: 'installed' },
          meta: { extensionTab: 'installed', pluginView: 'installed' }
        },
        {
          name: 'ExtensionMcp',
          path: 'mcp',
          component: () => import('@/views/extension/McpServersPage.vue'),
          meta: { extensionTab: 'mcp' }
        },
        {
          name: EXTENSION_DETAILS_ROUTE_NAME,
          path: 'plugins/:pluginId',
          component: () => import('@/views/ExtensionPage.vue'),
          props: { initialTab: 'installed' },
          meta: { extensionTab: 'installed', pluginView: 'installed' }
        }
      ]
    },
    {
      path: '/extension/:pluginId',
      redirect: (to: RouteLocationNormalized) => ({
        name: EXTENSION_DETAILS_ROUTE_NAME,
        params: { pluginId: to.params.pluginId },
        query: to.query,
        // MohoBot has no plugin components tab (AstrBot's #plugin-components
        // hash target was removed with the Components tab).
        hash: ''
      })
    },
    {
      name: 'Platforms',
      path: '/platforms',
      component: () => import('@/views/PlatformPage.vue')
    },
    {
      name: 'Providers',
      path: '/providers',
      component: () => import('@/views/ProviderPage.vue')
    },
    {
      name: 'Configs',
      path: '/config',
      component: () => import('@/views/ConfigPage.vue')
    },
    {
      path: '/normal',
      redirect: '/config'
    },
    {
      path: '/system',
      redirect: '/settings#system-config'
    },
    {
      name: 'SessionManagement',
      path: '/session-management',
      redirect: '/config?scope=sessions'
    },
    {
      name: 'Persona',
      path: '/persona',
      component: () => import('@/views/PersonaPage.vue')
    },
    {
      name: 'Data',
      path: '/data',
      component: () => import('@/views/DataPage.vue'),
      // Reopen the last visited tab, falling back to Conversations by default.
      redirect: (to: RouteLocationNormalized) => {
        const lastTab = localStorage.getItem('data_last_tab');
        return redirectToDataTab(
          lastTab && ['Conversation', 'Console'].includes(lastTab) ? lastTab : 'Conversation'
        )(to);
      },
      children: [
        {
          name: 'Conversation',
          path: 'conversations',
          component: () => import('@/views/conversation/ConversationWorkspacePage.vue'),
          meta: { dataTab: 'conversations' }
        },
        {
          name: 'Console',
          path: 'logs',
          component: () => import('@/views/ConsolePage.vue'),
          meta: { dataTab: 'logs' }
        },
      ]
    },
    {
      path: '/conversation',
      redirect: redirectToDataTab('Conversation')
    },
    {
      path: '/console',
      redirect: redirectToDataTab('Console')
    },
    {
      name: 'CronJobs',
      path: '/cron',
      redirect: '/tasks'
    },
    {
      name: 'MohoWorld',
      path: '/world',
      component: () => import('@/views/moho/WorldPage.vue')
    },
    {
      name: 'MohoDevice',
      path: '/device',
      component: () => import('@/views/moho/DevicePage.vue')
    },
    {
      name: 'MohoAffinity',
      path: '/affinity',
      component: () => import('@/views/moho/AffinityPage.vue')
    },
    {
      name: 'MohoMemory',
      path: '/memory',
      component: () => import('@/views/moho/MemoryPage.vue')
    },
    {
      name: 'MohoJargon',
      path: '/jargon',
      component: () => import('@/views/moho/JargonPage.vue')
    },
    {
      name: 'MohoTasks',
      path: '/tasks',
      component: () => import('@/views/moho/TasksPage.vue')
    },
    {
      name: 'MohoSessions',
      path: '/sessions',
      component: () => import('@/views/moho/SessionsPage.vue')
    },
    {
      name: 'MohoUsers',
      path: '/users',
      component: () => import('@/views/moho/UsersPage.vue')
    },
    {
      name: 'MohoBots',
      path: '/bots',
      component: () => import('@/views/moho/BotsPage.vue')
    },
    {
      name: 'MohoModels',
      path: '/models',
      component: () => import('@/views/moho/ModelsPage.vue')
    },
    {
      name: 'MohoDebug',
      path: '/debug',
      component: () => import('@/views/moho/DebugPage.vue')
    },
    {
      name: 'MohoHealth',
      path: '/health',
      component: () => import('@/views/moho/HealthPage.vue')
    },
    {
      name: 'NativeKnowledgeBase',
      path: '/knowledge-base',
      component: () => import('@/views/knowledge-base/index.vue'),
      children: [
        {
          path: '',
          name: 'NativeKBList',
          component: () => import('@/views/knowledge-base/KBList.vue')
        },
        {
          path: ':kbId',
          name: 'NativeKBDetail',
          component: () => import('@/views/knowledge-base/KBDetail.vue'),
          props: true
        },
        {
          path: ':kbId/document/:docId',
          name: 'NativeDocumentDetail',
          component: () => import('@/views/knowledge-base/DocumentDetail.vue'),
          props: true
        }
      ]
    },

    {
      name: 'Chat',
      path: '/chat',
      component: () => import('@/views/ChatPage.vue'),
      children: [
        {
          path: ':conversationId',
          name: 'ChatDetail',
          component: () => import('@/views/ChatPage.vue'),
          props: true
        }
      ]
    },
    {
      name: 'Settings',
      path: '/settings',
      component: () => import('@/views/Settings.vue')
    },
  ]
};

export default MainRoutes;
