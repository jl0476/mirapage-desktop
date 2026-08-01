// Vue Router 配置

import { createRouter, createWebHistory } from 'vue-router';
import Home from '@/views/Home.vue';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'home',
      component: Home,
    },
    {
      path: '/shortcuts',
      name: 'shortcuts',
      component: () => import('@/views/Shortcuts.vue'),
    },
    {
      path: '/library',
      name: 'library',
      component: () => import('@/views/Library.vue'),
    },
    {
      path: '/bookmarks',
      name: 'bookmarks',
      component: () => import('@/views/Bookmarks.vue'),
    },
    {
      path: '/likes',
      name: 'likes',
      component: () => import('@/views/Likes.vue'),
    },
    {
      path: '/history',
      name: 'history',
      component: () => import('@/views/History.vue'),
    },
    {
      path: '/accounts',
      name: 'accounts',
      component: () => import('@/views/Accounts.vue'),
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('@/views/Settings.vue'),
    },
    {
      path: '/search',
      name: 'search',
      component: () => import('@/views/Search.vue'),
    },
  ],
});

export default router;